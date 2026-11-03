package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"embed"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/majd/ipatool/v2/pkg/appstore"
	"howett.net/plist"
)

// https://developer.apple.com/documentation/bundleresources/entitlements
type BundleEntitlements struct {
	AssociatedDomains []string `plist:"com.apple.developer.associated-domains"`
}

// https://developer.apple.com/documentation/bundleresources/information_property_list
type BundleInformation struct {
	CFBundleURLTypes []struct {
		CFBundleURLName    string   `plist:"CFBundleURLName,omitempty"`
		CFBundleTypeRole   string   `plist:"CFBundleTypeRole,omitempty"`
		CFBundleURLSchemes []string `plist:"CFBundleURLSchemes,omitempty"`
	}
}

// TODO Apple Watch subfolder eg Payload/Passbook.app/Watch/PassbookWatchApp.app/

type Bundle struct {
	App          appstore.App
	Information  BundleInformation
	Entitlements BundleEntitlements
}

// statusError carries an HTTP status for errors users can act on
type statusError struct {
	status int
	err    error
}

func (e statusError) Error() string { return e.err.Error() }

type server struct {
	appStore    appstore.AppStore
	store       Store
	ttl         time.Duration
	searchLimit int64

	// downloads purchase and fetch whole IPAs, so run one at a time
	downloadMu sync.Mutex
}

func envInt(name string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return fallback
}

func (s *server) login() error {
	_, err := s.appStore.Login(appstore.LoginInput{Email: os.Getenv("EMAIL"), Password: os.Getenv("PASSWORD")})
	if errors.Is(err, appstore.ErrAuthCodeRequired) {
		return errors.New("login needs a 2FA code; disable 2FA on the Apple account")
	}
	return err
}

func (s *server) account() (appstore.Account, error) {
	info, err := s.appStore.AccountInfo()
	if err == nil {
		return info.Account, nil
	}
	if err := s.login(); err != nil {
		return appstore.Account{}, fmt.Errorf("login failed: %w", err)
	}
	info, err = s.appStore.AccountInfo()
	return info.Account, err
}

// withLogin retries once after logging in again when the session token expires
func withLogin[T any](s *server, f func(appstore.Account) (T, error)) (T, error) {
	acc, err := s.account()
	if err != nil {
		var zero T
		return zero, err
	}
	out, err := f(acc)
	if errors.Is(err, appstore.ErrPasswordTokenExpired) {
		if err := s.login(); err != nil {
			return out, fmt.Errorf("login failed: %w", err)
		}
		if acc, err = s.account(); err != nil {
			return out, err
		}
		out, err = f(acc)
	}
	return out, err
}

// latest returns the newest extracted version, checking the App Store once the cached check is older than the TTL
func (s *server) latest(ctx context.Context, bundleID string) (*Version, error) {
	cached, err := s.store.Latest(bundleID)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, statusError{http.StatusBadRequest, err}
	}
	if cached != nil && time.Since(cached.Checked) < s.ttl {
		return s.store.Version(bundleID, cached.Version)
	}

	app, err := withLogin(s, func(acc appstore.Account) (appstore.App, error) {
		out, err := s.appStore.Lookup(appstore.LookupInput{Account: acc, BundleID: bundleID})
		return out.App, err
	})
	if errors.Is(err, appstore.ErrAppNotFound) {
		return nil, statusError{http.StatusNotFound, err}
	}
	if err != nil {
		return s.stale(bundleID, cached, err)
	}

	if v, err := s.store.Version(bundleID, app.Version); err == nil {
		return v, s.store.SetLatest(bundleID, Latest{Version: app.Version, Checked: time.Now().UTC()})
	}
	if app.Price > 0 {
		return nil, statusError{http.StatusBadRequest, errors.New("paid apps aren't supported")}
	}

	s.downloadMu.Lock()
	defer s.downloadMu.Unlock()
	// another request may have extracted this version while we waited
	if _, err := s.store.Version(bundleID, app.Version); err != nil {
		if err := s.extract(ctx, bundleID, app); err != nil {
			return s.stale(bundleID, cached, err)
		}
	}
	if err := s.store.SetLatest(bundleID, Latest{Version: app.Version, Checked: time.Now().UTC()}); err != nil {
		return nil, err
	}
	return s.store.Version(bundleID, app.Version)
}

// stale serves the previous version when the App Store can't be reached
func (s *server) stale(bundleID string, cached *Latest, err error) (*Version, error) {
	if cached == nil {
		return nil, err
	}
	log.Printf("serving stale %s %s: %v", bundleID, cached.Version, err)
	return s.store.Version(bundleID, cached.Version)
}

func (s *server) extract(ctx context.Context, bundleID string, app appstore.App) error {
	dir, err := os.MkdirTemp("", "ipa")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	ipa, err := withLogin(s, func(acc appstore.Account) (appstore.DownloadOutput, error) {
		input := appstore.DownloadInput{Context: ctx, Account: acc, App: app, OutputPath: dir}
		out, err := s.appStore.Download(input)
		if errors.Is(err, appstore.ErrLicenseRequired) {
			// first download of a free app needs a one-time purchase
			if err := s.appStore.Purchase(appstore.PurchaseInput{Account: acc, App: app}); err != nil && !errors.Is(err, appstore.ErrLicenseAlreadyExists) {
				return out, fmt.Errorf("purchase failed: %w", err)
			}
			out, err = s.appStore.Download(input)
		}
		return out, err
	})
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}

	files, err := extractFiles(ipa.DestinationPath)
	if err != nil {
		return err
	}
	return s.store.Save(bundleID, app, files)
}

var (
	mainBinary  = regexp.MustCompile(`^Payload/([^/]+)\.app/([^/]+)$`)
	infoPath    = regexp.MustCompile(`^Payload/[^/]+\.app/Info\.plist$`)
	privacyPath = regexp.MustCompile(`^Payload/[^/]+\.app/PrivacyInfo\.xcprivacy$`)
)

func readZipFile(file *zip.File) ([]byte, error) {
	src, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer src.Close()
	return io.ReadAll(src)
}

// extractFiles reads the main app's Info.plist, privacy manifest and entitlements from an IPA
func extractFiles(path string) (map[string][]byte, error) {
	zipReader, err := zip.OpenReader(path)
	if err != nil {
		return nil, err
	}
	defer zipReader.Close()

	files := map[string][]byte{}
	for _, file := range zipReader.File {
		switch {
		case infoPath.MatchString(file.Name):
			data, err := readZipFile(file)
			if err != nil {
				return nil, err
			}
			// Info.plist is usually binary, so store XML for downloads
			var info any
			if _, err := plist.Unmarshal(data, &info); err != nil {
				return nil, err
			}
			if files[infoPlist], err = plist.MarshalIndent(info, plist.XMLFormat, "\t"); err != nil {
				return nil, err
			}
		case privacyPath.MatchString(file.Name):
			if files[privacyInfo], err = readZipFile(file); err != nil {
				return nil, err
			}
		default:
			// Payload/MyApp.app/MyApp is the main binary, containing the entitlements plist
			matches := mainBinary.FindStringSubmatch(file.Name)
			if len(matches) == 3 && matches[1] == matches[2] {
				if files[entitlementsPlist], err = carveEntitlements(file); err != nil {
					return nil, err
				}
			}
		}
	}
	if files[infoPlist] == nil {
		return nil, errors.New("Info.plist not found in IPA")
	}
	return files, nil
}

// carveEntitlements finds the first newline-delimited plist in the binary
// could be faster by reading only __LINKEDIT section at end of binary, but backwards read is too complex due to decompression
func carveEntitlements(file *zip.File) ([]byte, error) {
	src, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer src.Close()

	// use Reader to ignore full buffer, unlike Scanner
	// buffer is much larger than plist line length, longest I've seen is 100 chars
	scanner := bufio.NewReader(src)
	lines := []byte{}
	for {
		line, err := scanner.ReadSlice('\n')
		if err != nil && err != bufio.ErrBufferFull {
			if errors.Is(err, io.EOF) {
				return nil, nil
			}
			return nil, err
		}
		if len(lines) == 0 {
			if bytes.HasPrefix(line, []byte("<plist")) {
				lines = append(lines, []byte("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n")...)
			}
		} else {
			if bytes.HasPrefix(line, []byte("</plist>")) {
				return append(lines, []byte("</plist>\n")...), nil
			}
			lines = append(lines, line...)
		}
	}
}

func (s *server) bundle(bundleID string, v *Version) (*Bundle, error) {
	b := Bundle{App: v.App}
	for name, target := range map[string]any{infoPlist: &b.Information, entitlementsPlist: &b.Entitlements} {
		path, err := s.store.File(bundleID, v.App.Version, name)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if _, err := plist.Unmarshal(data, target); err != nil {
			return nil, err
		}
	}
	return &b, nil
}

// resolve returns the requested version, or the latest if none was requested
func (s *server) resolve(c *gin.Context) (*Version, error) {
	id := c.Param("id")
	if version := c.Query("version"); version != "" {
		v, err := s.store.Version(id, version)
		if err != nil {
			return nil, statusError{http.StatusNotFound, errors.New("version not cached")}
		}
		return v, nil
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Minute)
	defer cancel()
	return s.latest(ctx, id)
}

func fail(c *gin.Context, err error) {
	status := http.StatusInternalServerError
	var se statusError
	if errors.As(err, &se) {
		status = se.status
	}
	log.Printf("%s: %v", c.Request.URL, err)
	c.String(status, err.Error())
}

//go:embed static/* templates/*
var content embed.FS

func main() {
	ttl, err := time.ParseDuration(os.Getenv("CACHE_TTL"))
	if err != nil {
		ttl = 24 * time.Hour
	}
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "cache"
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		log.Fatal(err)
	}
	// keep the session cookies with the data, so restarts don't log in from a "new" device
	appStore, err := newAppStore(filepath.Join(dataDir, ".ipatool"))
	if err != nil {
		log.Fatal(err)
	}
	s := &server{
		appStore:    appStore,
		store:       Store{dir: dataDir},
		ttl:         ttl,
		searchLimit: int64(envInt("SEARCH_LIMIT", 15)),
	}
	if _, err := s.account(); err != nil {
		log.Println(err)
	}

	r := gin.Default()
	r.SetHTMLTemplate(template.Must(template.New("").ParseFS(content, "templates/**/*")))

	r.GET("/", func(c *gin.Context) {
		c.HTML(http.StatusOK, "views/index.html", gin.H{})
	})

	r.GET("favicon.ico", func(c *gin.Context) {
		c.FileFromFS("static/favicon.ico", http.FS(content))
	})

	r.GET("/search", func(c *gin.Context) {
		query := strings.TrimSpace(c.Query("q"))
		if query == "" {
			c.String(http.StatusBadRequest, "missing search query")
			return
		}
		data, err := withLogin(s, func(acc appstore.Account) (appstore.SearchOutput, error) {
			return s.appStore.Search(appstore.SearchInput{Account: acc, Term: query, Limit: s.searchLimit})
		})
		if err != nil {
			fail(c, err)
			return
		}
		c.HTML(http.StatusOK, "views/search.html", gin.H{
			"Results":     data.Results,
			"Query":       query,
			"BundleQuery": strings.Contains(query, ".") && safeName.MatchString(query),
		})
	})

	r.GET("/bundle/:id", func(c *gin.Context) {
		v, err := s.resolve(c)
		if err != nil {
			fail(c, err)
			return
		}
		b, err := s.bundle(c.Param("id"), v)
		if err != nil {
			fail(c, err)
			return
		}
		versions, err := s.store.Versions(c.Param("id"))
		if err != nil {
			fail(c, err)
			return
		}
		domains := []string{}
		for _, domain := range b.Entitlements.AssociatedDomains {
			domains = append(domains, strings.TrimPrefix(domain, "applinks:"))
		}
		b.Entitlements.AssociatedDomains = domains
		_, privacyErr := s.store.File(c.Param("id"), v.App.Version, privacyInfo)
		c.HTML(http.StatusOK, "views/bundle.html", gin.H{
			"Id":       c.Param("id"),
			"Bundle":   b,
			"Version":  v,
			"Versions": versions,
			"Privacy":  privacyErr == nil,
		})
	})

	r.GET("/download/:id/:file", func(c *gin.Context) {
		v, err := s.resolve(c)
		if err != nil {
			fail(c, err)
			return
		}
		path, err := s.store.File(c.Param("id"), v.App.Version, c.Param("file"))
		if err != nil {
			fail(c, statusError{http.StatusNotFound, errors.New("file not found")})
			return
		}
		c.FileAttachment(path, fmt.Sprintf("%s_%s_%s", c.Param("id"), v.App.Version, c.Param("file")))
	})

	if err := r.Run(); err != nil {
		log.Fatal(err)
	}
}

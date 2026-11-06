// diff-viewer serves the web app and stores encrypted diffs that are too long for a link.
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var validID = regexp.MustCompile(`^[A-Za-z0-9_-]{16}$`)

type server struct {
	dir     string
	web     string
	ttl     time.Duration
	maxSize int64
	minFree uint64
	now     func() time.Time
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/diffs", s.create)
	mux.HandleFunc("GET /api/diffs/{id}", s.get)
	mux.HandleFunc("GET /", s.static)
	return headers(mux)
}

func headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (s *server) static(w http.ResponseWriter, r *http.Request) {
	name := filepath.Join(s.web, filepath.FromSlash(filepath.Clean("/"+r.URL.Path)))
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		// file names carry a content hash
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	if info, err := os.Stat(name); err != nil || info.IsDir() {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			http.NotFound(w, r)
			return
		}
		name = filepath.Join(s.web, "index.html")
	}
	http.ServeFile(w, r, name)
}

func (s *server) create(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.maxSize))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		http.Error(w, "diff too large", http.StatusRequestEntityTooLarge)
		return
	case err != nil:
		http.Error(w, "read failed", http.StatusBadRequest)
		return
	case len(data) < 12+16+1: // IV + GCM tag + at least one byte
		http.Error(w, "not an encrypted diff", http.StatusBadRequest)
		return
	}
	if free, err := freeBytes(s.dir); err != nil || free < uint64(len(data))+s.minFree {
		http.Error(w, "storage full", http.StatusInsufficientStorage)
		return
	}

	raw := make([]byte, 12)
	_, _ = rand.Read(raw)
	id := base64.RawURLEncoding.EncodeToString(raw)
	if err := writeFile(filepath.Join(s.dir, id), data); err != nil {
		slog.Error("store diff", "err", err)
		http.Error(w, "store failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"id":      id,
		"expires": s.now().Add(s.ttl).UTC().Format(time.RFC3339),
	})
}

func (s *server) get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID.MatchString(id) {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	name := filepath.Join(s.dir, id)
	f, err := os.Open(name)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	left := info.ModTime().Add(s.ttl).Sub(s.now())
	if left <= 0 {
		_ = os.Remove(name)
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Diff-Expires", info.ModTime().Add(s.ttl).UTC().Format(time.RFC3339))
	// stored diffs never change, so caches may keep them until they expire
	h.Set("Cache-Control", "public, max-age="+strconv.Itoa(int(left.Seconds()))+", immutable")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// sweep deletes expired diffs and temp files left by interrupted writes.
func (s *server) sweep() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		slog.Error("sweep", "err", err)
		return
	}
	now := s.now()
	removed := 0
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		temp := strings.HasPrefix(e.Name(), ".")
		if (temp && now.Sub(info.ModTime()) > time.Hour) || (!temp && now.Sub(info.ModTime()) > s.ttl) {
			if os.Remove(filepath.Join(s.dir, e.Name())) == nil {
				removed++
			}
		}
	}
	if removed > 0 {
		slog.Info("swept expired diffs", "count", removed)
	}
}

func writeFile(name string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(name), ".upload-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), name)
}

func freeBytes(dir string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	ttl, err := time.ParseDuration(env("TTL", "8760h"))
	if err != nil {
		slog.Error("TTL", "err", err)
		os.Exit(1)
	}
	maxSize, err := strconv.ParseInt(env("MAX_BYTES", "16777216"), 10, 64)
	if err != nil {
		slog.Error("MAX_BYTES", "err", err)
		os.Exit(1)
	}
	s := &server{
		dir:     env("DATA_DIR", "/data"),
		web:     env("WEB_DIR", "/web"),
		ttl:     ttl,
		maxSize: maxSize,
		minFree: 32 << 20,
		now:     time.Now,
	}
	go func() {
		for {
			s.sweep()
			time.Sleep(time.Hour)
		}
	}()
	addr := env("ADDR", ":8080")
	slog.Info("listening", "addr", addr, "data", s.dir, "ttl", ttl)
	srv := &http.Server{Addr: addr, Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}

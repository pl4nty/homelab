package main

import (
	"archive/zip"
	"bytes"
	"html/template"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/majd/ipatool/v2/pkg/appstore"
	"howett.net/plist"
)

func writeIPA(t *testing.T, files map[string][]byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.ipa")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	w := zip.NewWriter(f)
	for name, data := range files {
		fw, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExtractFiles(t *testing.T) {
	info, err := plist.Marshal(map[string]any{
		"CFBundleURLTypes": []map[string]any{{"CFBundleURLName": "share", "CFBundleURLSchemes": []string{"pages"}}},
	}, plist.BinaryFormat)
	if err != nil {
		t.Fatal(err)
	}
	binary := "\x00\xfejunk\n<plist version=\"1.0\">\n<dict>\n<key>com.apple.developer.associated-domains</key>\n<array>\n<string>applinks:example.com</string>\n</array>\n</dict>\n</plist>\n\x00more"
	path := writeIPA(t, map[string][]byte{
		"Payload/Pages.app/Info.plist":                                     info,
		"Payload/Pages.app/Pages":                                          []byte(binary),
		"Payload/Pages.app/PrivacyInfo.xcprivacy":                          []byte("<plist/>"),
		"Payload/Pages.app/PlugIns/Share.appex/Info.plist":                 []byte("ignored"),
		"Payload/Pages.app/Frameworks/Lib.framework/PrivacyInfo.xcprivacy": []byte("ignored"),
	})

	files, err := extractFiles(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(files[infoPlist], []byte("<?xml")) {
		t.Errorf("Info.plist not converted to XML: %q", files[infoPlist])
	}
	if string(files[privacyInfo]) != "<plist/>" {
		t.Errorf("PrivacyInfo = %q", files[privacyInfo])
	}

	var ent BundleEntitlements
	if _, err := plist.Unmarshal(files[entitlementsPlist], &ent); err != nil {
		t.Fatal(err)
	}
	if len(ent.AssociatedDomains) != 1 || ent.AssociatedDomains[0] != "applinks:example.com" {
		t.Errorf("entitlements = %+v", ent)
	}
}

func TestStore(t *testing.T) {
	s := Store{dir: t.TempDir()}
	for _, version := range []string{"1.0", "1.1"} {
		app := appstore.App{BundleID: "com.example.app", Version: version}
		if err := s.Save("com.example.app", app, map[string][]byte{infoPlist: []byte(version)}); err != nil {
			t.Fatal(err)
		}
	}

	versions, err := s.Versions("com.example.app")
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 || versions[0].App.Version != "1.1" {
		t.Errorf("versions = %+v", versions)
	}
	if _, err := s.File("com.example.app", "1.0", infoPlist); err != nil {
		t.Error(err)
	}
	if _, err := s.File("com.example.app", "1.0", privacyInfo); !os.IsNotExist(err) {
		t.Errorf("missing file: %v", err)
	}
	for _, bad := range []string{"..", "../etc", ".ipatool", "a/b"} {
		if _, err := s.Version(bad, "1.0"); err == nil || !strings.Contains(err.Error(), "invalid") {
			t.Errorf("bundle ID %q accepted", bad)
		}
		if _, err := s.Version("com.example.app", bad); err == nil || !strings.Contains(err.Error(), "invalid") {
			t.Errorf("version %q accepted", bad)
		}
	}
	if _, err := s.File("com.example.app", "1.0", "version.json"); err == nil {
		t.Error("arbitrary file served")
	}
}

func TestExemptSchemes(t *testing.T) {
	var info BundleInformation
	data, err := plist.Marshal(map[string]any{"CFBundleURLTypes": []map[string]any{
		{"CFBundleURLSchemes": []string{"http", "https"}},
		{"CFBundleURLSchemes": []string{"googleapp", "google"}},
		{"CFBundleURLSchemes": []string{"Google", "google-deeplink"}},
	}}, plist.XMLFormat)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plist.Unmarshal(data, &info); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(exemptSchemes(info), ";"); got != "googleapp;google;google-deeplink" {
		t.Errorf("exemptSchemes = %q", got)
	}
}

func TestUniversalLinks(t *testing.T) {
	got := universalLinks([]string{"applinks:goo.gl", "webcredentials:google.com", "applinks:*.example.com?mode=developer", "applinks:goo.gl"})
	want := "http://goo.gl/* https://goo.gl/* http://*.example.com/* https://*.example.com/*"
	if strings.Join(got, " ") != want {
		t.Errorf("universalLinks = %q", got)
	}
}

func TestBundleTemplate(t *testing.T) {
	tmpl := template.Must(template.New("").ParseFS(content, "templates/**/*"))
	v := &Version{App: appstore.App{ID: 284815942, Name: "Google", Version: "445.5"}}
	var out bytes.Buffer
	err := tmpl.ExecuteTemplate(&out, "views/bundle.html", map[string]any{
		"Id":          "com.google.GoogleMobile",
		"Bundle":      &Bundle{App: v.App},
		"Version":     v,
		"Versions":    []Version{*v},
		"Schemes":     []string{"googleapp", "google"},
		"SchemeValue": "googleapp;google",
		"Links":       []string{"http://goo.gl/*", "https://goo.gl/*"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`>googleapp;google</textarea>`, `data-copy="https://goo.gl/*"`} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("bundle page is missing %s", want)
		}
	}
}

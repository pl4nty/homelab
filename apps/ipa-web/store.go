package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/majd/ipatool/v2/pkg/appstore"
)

// files extracted from each IPA, served at /download/:id/:file
const (
	infoPlist         = "Info.plist"
	entitlementsPlist = "entitlements.plist"
	privacyInfo       = "PrivacyInfo.xcprivacy"
)

var safeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// Version is one extracted App Store version, kept indefinitely
type Version struct {
	App       appstore.App `json:"app"`
	Extracted time.Time    `json:"extracted"`
}

// Latest records the newest version and when the App Store was last checked
type Latest struct {
	Version string    `json:"version"`
	Checked time.Time `json:"checked"`
}

// Store lays out <dir>/<bundle>/latest.json and <dir>/<bundle>/<version>/{version.json,Info.plist,...}
type Store struct {
	dir string
}

func (s Store) bundleDir(bundleID string) (string, error) {
	if !safeName.MatchString(bundleID) {
		return "", errors.New("invalid bundle ID")
	}
	return filepath.Join(s.dir, bundleID), nil
}

func (s Store) versionDir(bundleID, version string) (string, error) {
	dir, err := s.bundleDir(bundleID)
	if err != nil {
		return "", err
	}
	if !safeName.MatchString(version) {
		return "", errors.New("invalid version")
	}
	return filepath.Join(dir, version), nil
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

// writeJSON replaces the file atomically so readers never see a partial write
func writeJSON(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s Store) Latest(bundleID string) (*Latest, error) {
	dir, err := s.bundleDir(bundleID)
	if err != nil {
		return nil, err
	}
	var latest Latest
	if err := readJSON(filepath.Join(dir, "latest.json"), &latest); err != nil {
		return nil, err
	}
	return &latest, nil
}

func (s Store) SetLatest(bundleID string, latest Latest) error {
	dir, err := s.bundleDir(bundleID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return writeJSON(filepath.Join(dir, "latest.json"), latest)
}

func (s Store) Version(bundleID, version string) (*Version, error) {
	dir, err := s.versionDir(bundleID, version)
	if err != nil {
		return nil, err
	}
	var v Version
	if err := readJSON(filepath.Join(dir, "version.json"), &v); err != nil {
		return nil, err
	}
	return &v, nil
}

// Versions lists extracted versions, newest first
func (s Store) Versions(bundleID string) ([]Version, error) {
	dir, err := s.bundleDir(bundleID)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	versions := []Version{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if v, err := s.Version(bundleID, entry.Name()); err == nil {
			versions = append(versions, *v)
		}
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].Extracted.After(versions[j].Extracted) })
	return versions, nil
}

// File returns the path of an extracted file, or an error if it was never extracted
func (s Store) File(bundleID, version, name string) (string, error) {
	switch name {
	case infoPlist, entitlementsPlist, privacyInfo:
	default:
		return "", errors.New("unknown file")
	}
	dir, err := s.versionDir(bundleID, version)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, name)
	_, err = os.Stat(path)
	return path, err
}

// Save writes extracted files to a temporary directory, then renames it into place
func (s Store) Save(bundleID string, app appstore.App, files map[string][]byte) error {
	dir, err := s.versionDir(bundleID, app.Version)
	if err != nil {
		return err
	}
	tmp := dir + ".tmp"
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	if err := os.MkdirAll(tmp, 0700); err != nil {
		return err
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(tmp, name), data, 0600); err != nil {
			return err
		}
	}
	if err := writeJSON(filepath.Join(tmp, "version.json"), Version{App: app, Extracted: time.Now().UTC()}); err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.Rename(tmp, dir)
}

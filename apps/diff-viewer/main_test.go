package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newServer(t *testing.T) (*server, *time.Time) {
	t.Helper()
	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("<!doctype html>app"), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	s := &server{dir: t.TempDir(), web: web, ttl: 365 * 24 * time.Hour, maxSize: 1024, minFree: 0}
	s.now = func() time.Time { return now }
	return s, &now
}

func do(t *testing.T, s *server, method, path string, body []byte) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, httptest.NewRequest(method, path, bytes.NewReader(body)))
	return rec.Result()
}

func create(t *testing.T, s *server, body []byte) (id, expires string) {
	t.Helper()
	res := do(t, s, http.MethodPost, "/api/diffs", body)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d", res.StatusCode)
	}
	var out struct{ ID, Expires string }
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.ID, out.Expires
}

func TestRoundTrip(t *testing.T) {
	s, now := newServer(t)
	blob := bytes.Repeat([]byte{7}, 64)
	id, expires := create(t, s, blob)
	if !validID.MatchString(id) {
		t.Fatalf("id %q", id)
	}
	if want := now.Add(s.ttl).UTC().Format(time.RFC3339); expires != want {
		t.Fatalf("expires %s, want %s", expires, want)
	}

	res := do(t, s, http.MethodGet, "/api/diffs/"+id, nil)
	got, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || !bytes.Equal(got, blob) {
		t.Fatalf("get: %d %v", res.StatusCode, got)
	}
	if h := res.Header.Get("Diff-Expires"); h != expires {
		t.Fatalf("Diff-Expires %q, want %q", h, expires)
	}
}

func TestExpired(t *testing.T) {
	s, now := newServer(t)
	id, _ := create(t, s, bytes.Repeat([]byte{1}, 64))
	*now = now.Add(s.ttl + time.Second)
	if res := do(t, s, http.MethodGet, "/api/diffs/"+id, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("expired get: %d", res.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(s.dir, id)); !os.IsNotExist(err) {
		t.Fatalf("expired file still on disk: %v", err)
	}
}

func TestSweep(t *testing.T) {
	s, now := newServer(t)
	old, _ := create(t, s, bytes.Repeat([]byte{1}, 64))
	*now = now.Add(s.ttl - time.Hour)
	fresh, _ := create(t, s, bytes.Repeat([]byte{2}, 64))
	// files take the real clock's mtime, so age the first one by hand
	past := time.Now().Add(-s.ttl - time.Hour)
	if err := os.Chtimes(filepath.Join(s.dir, old), past, past); err != nil {
		t.Fatal(err)
	}
	*now = time.Now()
	s.sweep()
	if _, err := os.Stat(filepath.Join(s.dir, old)); !os.IsNotExist(err) {
		t.Fatal("sweep kept an expired diff")
	}
	if _, err := os.Stat(filepath.Join(s.dir, fresh)); err != nil {
		t.Fatal("sweep removed a live diff")
	}
}

func TestRejects(t *testing.T) {
	s, _ := newServer(t)
	cases := []struct {
		method, path string
		body         []byte
		want         int
	}{
		{http.MethodPost, "/api/diffs", bytes.Repeat([]byte{1}, 2048), http.StatusRequestEntityTooLarge},
		{http.MethodPost, "/api/diffs", []byte("short"), http.StatusBadRequest},
		{http.MethodGet, "/api/diffs/..%2F..%2Fetc%2Fpasswd", nil, http.StatusNotFound},
		{http.MethodGet, "/api/diffs/AAAAAAAAAAAAAAAA", nil, http.StatusNotFound},
	}
	for _, c := range cases {
		if res := do(t, s, c.method, c.path, c.body); res.StatusCode != c.want {
			t.Errorf("%s %s: %d, want %d", c.method, c.path, res.StatusCode, c.want)
		}
	}
	s.minFree = 1 << 62
	if res := do(t, s, http.MethodPost, "/api/diffs", bytes.Repeat([]byte{1}, 64)); res.StatusCode != http.StatusInsufficientStorage {
		t.Errorf("full disk: %d", res.StatusCode)
	}
}

func TestStatic(t *testing.T) {
	s, _ := newServer(t)
	for _, path := range []string{"/", "/d/AAAAAAAAAAAAAAAA"} {
		res := do(t, s, http.MethodGet, path, nil)
		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != http.StatusOK || !strings.Contains(string(body), "app") {
			t.Errorf("%s: %d %q", path, res.StatusCode, body)
		}
		if res.Header.Get("Cache-Control") != "no-cache" {
			t.Errorf("%s: Cache-Control %q", path, res.Header.Get("Cache-Control"))
		}
	}
	if res := do(t, s, http.MethodGet, "/assets/missing.js", nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("missing asset: %d", res.StatusCode)
	}
}

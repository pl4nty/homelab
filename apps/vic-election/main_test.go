package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

const listJSON = `{"results":{"electorates":[{"code":"ALBE","name":"Albert Park","updated":"2026-11-28T20:12:06+11:00","margin":"11.2","counted":"9.9","isDoubtful":true,"isFinalResult":false,
"holdingParty":{"code":"ALP","name":"Labor Party","short":"Labor"},"swingDialLabel":"17.4% swing to LIB",
"swingDial":[{"name":"Sonya Semmens","party":{"code":"GRN","name":"Greens","short":"Greens"},"predicted2CP":{"votes":2108,"pct":"43.8","swing":"-17.4"}},
{"name":"Andrew Cook","party":{"code":"LIB","name":"Liberal Party","short":"Liberal"},"predicted2CP":{"votes":2708,"pct":"56.2","swing":"+17.4"}}]},
{"code":"ZZZZ","name":"Nowhere","counted":"0","holdingParty":{"code":"NAT","name":"Nationals"},"swingDial":[{"name":"A","party":{"code":"NAT"},"predicted2CP":null},{"name":"B","party":{"code":"ONP"}}]}]}}`

const overallJSON = `{"results":{"updated":"2026-11-28T20:13:01+11:00","counted":"9.0","inDoubt":48,"toWin":45,"totalSeats":88,"isFinalResult":false,"results":[{"code":"ALP","name":"Labor","seats":1}]}}`

func abcServer(t *testing.T, fail *atomic.Bool, calls *atomic.Int32) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		var props struct {
			Meta map[string]any `json:"meta"`
		}
		if err := json.Unmarshal([]byte(r.URL.Query().Get("props")), &props); err != nil || props.Meta["electionCode"] != "VIC26" {
			t.Errorf("props = %q", r.URL.Query().Get("props"))
		}
		switch r.URL.Query().Get("name") {
		case "ElectionElectorateList":
			w.Write([]byte(listJSON))
		case "ElectionOverallResults":
			w.Write([]byte(overallJSON))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestResults(t *testing.T) {
	var fail atomic.Bool
	var calls atomic.Int32
	abc := abcServer(t, &fail, &calls)
	now := time.Date(2026, 11, 28, 9, 15, 0, 0, time.UTC)
	f := &feed{base: abc.URL, client: abc.Client(), ttl: 30 * time.Second, now: func() time.Time { return now }}
	web := fstest.MapFS{"index.html": {Data: []byte("<title>x</title>")}, "districts.json": {Data: []byte("{}")}}
	h := routes(f, web)

	get := func() (*httptest.ResponseRecorder, results) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/results", nil))
		var r results
		if rec.Code == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil {
				t.Fatal(err)
			}
		}
		return rec, r
	}

	rec, r := get()
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=30" {
		t.Errorf("Cache-Control = %q", got)
	}
	if r.Overall == nil || r.Overall.Counted != "9.0" || r.Overall.ToWin != 45 {
		t.Errorf("overall = %+v", r.Overall)
	}
	if len(r.Electorates) != 2 {
		t.Fatalf("electorates = %d", len(r.Electorates))
	}
	ap := r.Electorates[0]
	if ap.Held.Name != "Labor" || ap.PriorMargin != "11.2" || len(ap.Cands) != 2 {
		t.Fatalf("Albert Park = %+v", ap)
	}
	if ap.Cands[0].Party.Code != "LIB" || *ap.Cands[0].Pct != 56.2 || *ap.Cands[0].Votes != 2708 || ap.Cands[1].Party.Code != "GRN" {
		t.Errorf("Albert Park not sorted by 2CP: %+v", ap.Cands)
	}
	if nw := r.Electorates[1]; nw.Cands[0].Pct != nil || nw.Held.Name != "Nationals" {
		t.Errorf("Nowhere = %+v", nw)
	}

	before := calls.Load()
	now = now.Add(10 * time.Second)
	rec, _ = get()
	if calls.Load() != before {
		t.Error("cached results refetched")
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=20" {
		t.Errorf("cached Cache-Control = %q", got)
	}

	fail.Store(true)
	now = now.Add(time.Minute)
	rec, r = get()
	if rec.Code != http.StatusOK || !r.Stale || len(r.Electorates) != 2 {
		t.Errorf("stale fallback: %d %+v", rec.Code, r)
	}
}

func TestResultsUnavailable(t *testing.T) {
	var fail atomic.Bool
	var calls atomic.Int32
	fail.Store(true)
	abc := abcServer(t, &fail, &calls)
	f := &feed{base: abc.URL, client: abc.Client(), ttl: 30 * time.Second, now: time.Now}
	rec := httptest.NewRecorder()
	routes(f, fstest.MapFS{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/results", nil))
	if rec.Code != http.StatusBadGateway || rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("got %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
}

func TestStatic(t *testing.T) {
	web := fstest.MapFS{"index.html": {Data: []byte("<title>x</title>")}, "districts.json": {Data: []byte("{}")}}
	h := routes(&feed{}, web)
	for path, cc := range map[string]string{"/": "public, max-age=60", "/districts.json": "public, max-age=86400"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != cc {
			t.Errorf("%s: %d %q", path, rec.Code, rec.Header().Get("Cache-Control"))
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/main.go", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("/main.go: %d", rec.Code)
	}
}

// vic-election maps the top two candidates in each Victorian Legislative Assembly district from the ABC's live results feed.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

const source = "https://www.abc.net.au/news/elections/vic/2026/results"

var meta = map[string]any{
	"year": "2026", "state": "vic", "maxSwing": 15, "totalSeats": 88, "toWin": 45, "useV4": true,
	"electionCode": "VIC26", "chamberCode": "Assembly", "accumulateCandidates": false, "maxParties": 5,
	"showOther": false, "zeroResults": false, "disable2PP": true, "pollingDelay": 60000,
	"remoteContentPath": "https://www.abc.net.au/dat/news/elections/vic/2026", "resultsDir": "results",
	"picturePath": "https://www.abc.net.au/dat/news/elections/vic/2026/guide/photos/",
}

type abcParty struct {
	Code  string `json:"code"`
	Name  string `json:"name"`
	Short string `json:"short"`
}

type abcCount struct {
	Votes *int   `json:"votes"`
	Pct   string `json:"pct"`
	Swing string `json:"swing"`
}

type abcElectorate struct {
	Code         string   `json:"code"`
	Name         string   `json:"name"`
	Updated      string   `json:"updated"`
	Margin       string   `json:"margin"`
	Counted      string   `json:"counted"`
	IsDoubtful   bool     `json:"isDoubtful"`
	IsFinal      bool     `json:"isFinalResult"`
	HoldingParty abcParty `json:"holdingParty"`
	Label        string   `json:"swingDialLabel"`
	SwingDial    []struct {
		Name      string    `json:"name"`
		Party     abcParty  `json:"party"`
		Predicted *abcCount `json:"predicted2CP"`
		Simple    *abcCount `json:"simple2CP"`
	} `json:"swingDial"`
}

type abcList struct {
	Results struct {
		Electorates []abcElectorate `json:"electorates"`
	} `json:"results"`
}

type abcOverall struct {
	Results struct {
		Updated    string `json:"updated"`
		Counted    string `json:"counted"`
		InDoubt    int    `json:"inDoubt"`
		ToWin      int    `json:"toWin"`
		TotalSeats int    `json:"totalSeats"`
		IsFinal    bool   `json:"isFinalResult"`
		Results    []struct {
			Code  string `json:"code"`
			Name  string `json:"name"`
			Seats int    `json:"seats"`
		} `json:"results"`
	} `json:"results"`
}

type party struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type candidate struct {
	Name  string   `json:"name"`
	Party party    `json:"party"`
	Votes *int     `json:"votes"`
	Pct   *float64 `json:"pct"`
	Swing string   `json:"swing"`
}

type electorate struct {
	Code        string      `json:"code"`
	Name        string      `json:"name"`
	Updated     string      `json:"updated"`
	Counted     string      `json:"counted"`
	PriorMargin string      `json:"priorMargin"`
	Held        party       `json:"held"`
	IsFinal     bool        `json:"isFinal"`
	IsDoubtful  bool        `json:"isDoubtful"`
	Label       string      `json:"label"`
	Cands       []candidate `json:"cands"`
}

type overall struct {
	Updated    string `json:"updated"`
	Counted    string `json:"counted"`
	InDoubt    int    `json:"inDoubt"`
	ToWin      int    `json:"toWin"`
	TotalSeats int    `json:"totalSeats"`
	IsFinal    bool   `json:"isFinal"`
}

type results struct {
	Fetched     time.Time    `json:"fetched"`
	Stale       bool         `json:"stale"`
	Source      string       `json:"source"`
	Overall     *overall     `json:"overall"`
	Electorates []electorate `json:"electorates"`
}

func toParty(p abcParty) party {
	if p.Short != "" {
		return party{p.Code, p.Short}
	}
	return party{p.Code, p.Name}
}

func convert(list abcList, ov *abcOverall, now time.Time) results {
	r := results{Fetched: now, Source: source, Electorates: []electorate{}}
	if ov != nil {
		o := ov.Results
		r.Overall = &overall{o.Updated, o.Counted, o.InDoubt, o.ToWin, o.TotalSeats, o.IsFinal}
	}
	for _, e := range list.Results.Electorates {
		out := electorate{
			Code: e.Code, Name: e.Name, Updated: e.Updated, Counted: e.Counted, PriorMargin: e.Margin,
			Held: toParty(e.HoldingParty), IsFinal: e.IsFinal, IsDoubtful: e.IsDoubtful, Label: e.Label,
			Cands: []candidate{},
		}
		for _, c := range e.SwingDial {
			n := c.Predicted
			if n == nil {
				n = c.Simple
			}
			cand := candidate{Name: c.Name, Party: toParty(c.Party)}
			if n != nil {
				cand.Votes = n.Votes
				cand.Swing = n.Swing
				if v, err := strconv.ParseFloat(n.Pct, 64); err == nil {
					cand.Pct = &v
				}
			}
			out.Cands = append(out.Cands, cand)
		}
		sort.SliceStable(out.Cands, func(i, j int) bool { return pct(out.Cands[i]) > pct(out.Cands[j]) })
		r.Electorates = append(r.Electorates, out)
	}
	return r
}

func pct(c candidate) float64 {
	if c.Pct == nil {
		return -1
	}
	return *c.Pct
}

type feed struct {
	base   string
	client *http.Client
	ttl    time.Duration
	now    func() time.Time

	mu      sync.Mutex
	body    []byte
	fetched time.Time
}

func (f *feed) get(ctx context.Context, name string, m map[string]any, v any) error {
	props, err := json.Marshal(map[string]any{"meta": m})
	if err != nil {
		return err
	}
	u := f.base + "?name=" + url.QueryEscape(name) + "&props=" + url.QueryEscape(string(props))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; vic-election)")
	res, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", name, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(v)
}

func (f *feed) fetch(ctx context.Context) ([]byte, error) {
	var list abcList
	if err := f.get(ctx, "ElectionElectorateList", meta, &list); err != nil {
		return nil, err
	}
	om := map[string]any{"showShare": true}
	for k, v := range meta {
		om[k] = v
	}
	var ov abcOverall
	ovp := &ov
	if err := f.get(ctx, "ElectionOverallResults", om, &ov); err != nil {
		slog.Warn("overall results", "err", err)
		ovp = nil
	}
	return json.Marshal(convert(list, ovp, f.now()))
}

func (f *feed) results(ctx context.Context) ([]byte, time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.body != nil && f.now().Sub(f.fetched) < f.ttl {
		return f.body, f.fetched, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	body, err := f.fetch(ctx)
	if err != nil {
		if f.body != nil {
			slog.Warn("serving stale results", "err", err, "age", f.now().Sub(f.fetched))
			var r results
			if json.Unmarshal(f.body, &r) == nil {
				r.Stale = true
				if b, err := json.Marshal(r); err == nil {
					return b, f.fetched, nil
				}
			}
			return f.body, f.fetched, nil
		}
		return nil, time.Time{}, err
	}
	f.body, f.fetched = body, f.now()
	return f.body, f.fetched, nil
}

func (f *feed) handle(w http.ResponseWriter, r *http.Request) {
	body, fetched, err := f.results(r.Context())
	if err != nil {
		slog.Error("results", "err", err)
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "results unavailable", http.StatusBadGateway)
		return
	}
	age := int(f.now().Sub(fetched).Seconds())
	maxAge := int(f.ttl.Seconds()) - age
	if maxAge < 1 {
		maxAge = 1
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", maxAge))
	w.Write(body)
}

func routes(f *feed, web fs.FS) http.Handler {
	files := http.FileServerFS(web)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/results", f.handle)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /districts.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=86400")
		files.ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=60")
		files.ServeHTTP(w, r)
	})
	return headers(mux)
}

func headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	ttl, err := time.ParseDuration(env("TTL", "30s"))
	if err != nil {
		slog.Error("TTL", "err", err)
		os.Exit(1)
	}
	web, err := fs.Sub(webFS, "web")
	if err != nil {
		slog.Error("web", "err", err)
		os.Exit(1)
	}
	f := &feed{
		base:   env("ABC_URL", "https://www.abc.net.au/news-web/api/loader/channelrefetch"),
		client: &http.Client{Timeout: 15 * time.Second},
		ttl:    ttl,
		now:    time.Now,
	}
	addr := env("ADDR", ":8080")
	slog.Info("listening", "addr", addr, "ttl", ttl)
	srv := &http.Server{Addr: addr, Handler: routes(f, web), ReadHeaderTimeout: 10 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}

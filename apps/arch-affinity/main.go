// arch-affinity is a mutating webhook that requires pods to run on a node
// os and architecture that every one of their images supports.
package main

import (
	"crypto/tls"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	addr := flag.String("addr", ":8443", "listen address")
	certDir := flag.String("cert-dir", "/tls", "directory holding tls.crt and tls.key")
	flag.Parse()

	certFile, keyFile := filepath.Join(*certDir, "tls.crt"), filepath.Join(*certDir, "tls.key")
	if _, err := tls.LoadX509KeyPair(certFile, keyFile); err != nil {
		fatal("load certificate", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/mutate", &handler{platforms: newResolver().platforms})
	mux.HandleFunc("/healthz", func(http.ResponseWriter, *http.Request) {})
	srv := &http.Server{
		Addr:    *addr,
		Handler: mux,
		// cert-manager renews the secret in place
		TLSConfig: &tls.Config{GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			cert, err := tls.LoadX509KeyPair(certFile, keyFile)
			return &cert, err
		}},
		ReadHeaderTimeout: 10 * time.Second,
	}
	slog.Info("listening", "addr", *addr)
	fatal("serve", srv.ListenAndServeTLS("", ""))
}

func fatal(msg string, err error) {
	slog.Error(msg, "err", err)
	os.Exit(1)
}

// arch-affinity is a mutating webhook that requires pods to run on a node
// architecture that every one of their images supports.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"flag"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	admissionclient "k8s.io/client-go/kubernetes/typed/admissionregistration/v1"
	"k8s.io/client-go/rest"
)

func main() {
	addr := flag.String("addr", ":8443", "listen address")
	service := flag.String("service", "arch-affinity.kube-system.svc", "DNS name the API server calls the webhook on")
	webhook := flag.String("webhook", "arch-affinity", "MutatingWebhookConfiguration to give the CA bundle")
	flag.Parse()

	cert, ca, err := selfSigned(*service)
	if err != nil {
		fatal("generate certificate", err)
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		fatal("load config", err)
	}
	// a fresh certificate per start avoids storing a key; failurePolicy Ignore covers the restart
	if err := setCABundle(context.Background(), cfg, *webhook, ca); err != nil {
		fatal("set CA bundle", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/mutate", &handler{archs: newResolver().archs})
	mux.HandleFunc("/healthz", func(http.ResponseWriter, *http.Request) {})
	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}},
		ReadHeaderTimeout: 10 * time.Second,
	}
	slog.Info("listening", "addr", *addr)
	fatal("serve", srv.ListenAndServeTLS("", ""))
}

func fatal(msg string, err error) {
	slog.Error(msg, "err", err)
	os.Exit(1)
}

func selfSigned(dnsName string) (tls.Certificate, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: dnsName},
		DNSNames:              []string{dnsName},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key},
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), nil
}

func setCABundle(ctx context.Context, cfg *rest.Config, name string, ca []byte) error {
	client, err := admissionclient.NewForConfig(cfg)
	if err != nil {
		return err
	}
	configs := client.MutatingWebhookConfigurations()
	mwc, err := configs.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	for i := range mwc.Webhooks {
		mwc.Webhooks[i].ClientConfig.CABundle = ca
	}
	_, err = configs.Update(ctx, mwc, metav1.UpdateOptions{})
	return err
}

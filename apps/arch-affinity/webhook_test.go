package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http/httptest"
	"net/url"
	"slices"
	"testing"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func image(t *testing.T, arch string) v1.Image {
	img, err := random.Image(64, 1)
	if err != nil {
		t.Fatal(err)
	}
	img, err = mutate.ConfigFile(img, &v1.ConfigFile{OS: "linux", Architecture: arch})
	if err != nil {
		t.Fatal(err)
	}
	return img
}

// testRegistry serves single-arch images and indexes, including an unknown/unknown attestation entry
func testRegistry(t *testing.T) string {
	srv := httptest.NewServer(registry.New(registry.Logger(log.New(io.Discard, "", 0))))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)

	push := func(repo string, f func(name.Reference) error) {
		ref, err := name.ParseReference(u.Host + "/" + repo)
		if err != nil {
			t.Fatal(err)
		}
		if err := f(ref); err != nil {
			t.Fatal(err)
		}
	}
	push("arm64", func(ref name.Reference) error { return remote.Write(ref, image(t, "arm64")) })
	index := func(archs ...string) v1.ImageIndex {
		idx := mutate.IndexMediaType(empty.Index, "application/vnd.oci.image.index.v1+json")
		for _, a := range archs {
			idx = mutate.AppendManifests(idx, mutate.IndexAddendum{Add: image(t, a), Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: a}}})
		}
		return mutate.AppendManifests(idx, mutate.IndexAddendum{Add: image(t, "amd64"), Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "unknown", Architecture: "unknown"}}})
	}
	push("multi", func(ref name.Reference) error { return remote.WriteIndex(ref, index("amd64", "arm64")) })
	push("riscv", func(ref name.Reference) error { return remote.WriteIndex(ref, index("amd64", "arm64", "riscv64")) })
	return u.Host
}

func archs(t *testing.T, patch []byte) []string {
	t.Helper()
	if patch == nil {
		return nil
	}
	var ops []struct {
		Value corev1.Affinity `json:"value"`
	}
	if err := json.Unmarshal(patch, &ops); err != nil {
		t.Fatal(err)
	}
	terms := ops[0].Value.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms
	exprs := terms[len(terms)-1].MatchExpressions
	return exprs[len(exprs)-1].Values
}

func TestPatch(t *testing.T) {
	host := testRegistry(t)
	h := &handler{archs: newResolver().archs}
	pod := func(images ...string) *corev1.Pod {
		p := &corev1.Pod{}
		for _, i := range images {
			p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Image: host + "/" + i})
		}
		return p
	}

	for _, tc := range []struct {
		name string
		pod  *corev1.Pod
		want []string
	}{
		{"index", pod("multi"), []string{"amd64", "arm64"}},
		{"single arch", pod("arm64"), []string{"arm64"}},
		{"intersection", pod("riscv", "multi"), []string{"amd64", "arm64"}},
		{"init container", func() *corev1.Pod {
			p := pod("riscv")
			p.Spec.InitContainers = []corev1.Container{{Image: host + "/arm64"}}
			return p
		}(), []string{"arm64"}},
		{"lookup error", pod("multi", "missing"), nil},
		{"arch selector", func() *corev1.Pod {
			p := pod("multi")
			p.Spec.NodeSelector = map[string]string{archLabel: "amd64"}
			return p
		}(), nil},
		{"daemonset", func() *corev1.Pod {
			p := pod("multi")
			p.OwnerReferences = []metav1.OwnerReference{{Kind: "DaemonSet"}}
			return p
		}(), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := archs(t, h.patch(context.Background(), "default", tc.pod)); !slices.Equal(got, tc.want) {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestPatchKeepsTerms(t *testing.T) {
	h := &handler{archs: func(context.Context, string) ([]string, error) { return []string{"arm64"}, nil }}
	p := &corev1.Pod{Spec: corev1.PodSpec{
		Containers: []corev1.Container{{Image: "x"}},
		Affinity: &corev1.Affinity{NodeAffinity: &corev1.NodeAffinity{
			RequiredDuringSchedulingIgnoredDuringExecution: &corev1.NodeSelector{NodeSelectorTerms: []corev1.NodeSelectorTerm{
				{MatchExpressions: []corev1.NodeSelectorRequirement{{Key: "a", Operator: corev1.NodeSelectorOpExists}}},
				{MatchExpressions: []corev1.NodeSelectorRequirement{{Key: "b", Operator: corev1.NodeSelectorOpExists}}},
			}},
		}},
	}}
	var ops []struct {
		Value corev1.Affinity `json:"value"`
	}
	if err := json.Unmarshal(h.patch(context.Background(), "default", p), &ops); err != nil {
		t.Fatal(err)
	}
	for i, term := range ops[0].Value.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms {
		if len(term.MatchExpressions) != 2 || term.MatchExpressions[1].Key != archLabel {
			t.Errorf("term %d: %+v", i, term.MatchExpressions)
		}
	}
	if len(p.Spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms[0].MatchExpressions) != 1 {
		t.Error("mutated the input pod")
	}
}

func TestResolverCachesDigests(t *testing.T) {
	host := testRegistry(t)
	r := newResolver()
	ref, _ := name.ParseReference(host + "/multi")
	desc, err := remote.Get(ref)
	if err != nil {
		t.Fatal(err)
	}
	digest := host + "/multi@" + desc.Digest.String()
	if _, err := r.archs(context.Background(), digest); err != nil {
		t.Fatal(err)
	}
	if c := r.cache[digest]; !c.expires.IsZero() {
		t.Error("digest should not expire")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.archs(ctx, digest); err != nil {
		t.Errorf("cached digest hit the registry: %v", err)
	}
	if _, err := r.archs(ctx, host+"/multi:latest"); !errors.Is(err, context.Canceled) {
		t.Errorf("uncached tag: %v", err)
	}
}

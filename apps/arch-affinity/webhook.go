package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
)

const (
	archLabel = "kubernetes.io/arch"
	osLabel   = "kubernetes.io/os"
	// tags can move, digests can't
	tagTTL = 10 * time.Minute
)

type handler struct {
	// platforms returns the os/arch pairs an image supports
	platforms func(ctx context.Context, image string) ([]string, error)
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var review admissionv1.AdmissionReview
	if err := json.NewDecoder(r.Body).Decode(&review); err != nil || review.Request == nil {
		http.Error(w, "invalid AdmissionReview", http.StatusBadRequest)
		return
	}
	resp := &admissionv1.AdmissionResponse{UID: review.Request.UID, Allowed: true}

	var pod corev1.Pod
	if err := json.Unmarshal(review.Request.Object.Raw, &pod); err != nil {
		http.Error(w, "invalid Pod", http.StatusBadRequest)
		return
	}
	// leave time to answer inside the webhook's timeoutSeconds
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if patch := h.patch(ctx, review.Request.Namespace, &pod); patch != nil {
		pt := admissionv1.PatchTypeJSONPatch
		resp.Patch, resp.PatchType = patch, &pt
	}

	review.Request, review.Response = nil, resp
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(review)
}

// patch returns a JSON patch that requires a platform every image supports,
// or nil to admit the pod unchanged
func (h *handler) patch(ctx context.Context, namespace string, pod *corev1.Pod) []byte {
	if constrained(pod) {
		return nil
	}
	log := slog.With("namespace", namespace, "pod", pod.GenerateName+pod.Name)

	var allowed []string
	for i, c := range slices.Concat(pod.Spec.InitContainers, pod.Spec.Containers) {
		platforms, err := h.platforms(ctx, c.Image)
		if err != nil {
			log.Warn("skipped: image lookup failed", "image", c.Image, "err", err)
			return nil
		}
		if i == 0 {
			allowed = platforms
		} else {
			allowed = slices.DeleteFunc(slices.Clone(allowed), func(p string) bool { return !slices.Contains(platforms, p) })
		}
	}
	if len(allowed) == 0 {
		log.Warn("skipped: images share no platform")
		return nil
	}

	// a node matches os AND arch, so each os gets its own term
	var oses []string
	archs := map[string][]string{}
	for _, p := range allowed {
		os, arch, _ := strings.Cut(p, "/")
		if archs[os] == nil {
			oses = append(oses, os)
		}
		archs[os] = append(archs[os], arch)
	}

	affinity := pod.Spec.Affinity.DeepCopy()
	if affinity == nil {
		affinity = &corev1.Affinity{}
	}
	if affinity.NodeAffinity == nil {
		affinity.NodeAffinity = &corev1.NodeAffinity{}
	}
	existing := []corev1.NodeSelectorTerm{{}}
	if r := affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution; r != nil && len(r.NodeSelectorTerms) > 0 {
		existing = r.NodeSelectorTerms
	}
	// terms are ORed, so each existing term is split per os
	var terms []corev1.NodeSelectorTerm
	for _, t := range existing {
		for _, os := range oses {
			t := *t.DeepCopy()
			t.MatchExpressions = append(t.MatchExpressions,
				corev1.NodeSelectorRequirement{Key: osLabel, Operator: corev1.NodeSelectorOpIn, Values: []string{os}},
				corev1.NodeSelectorRequirement{Key: archLabel, Operator: corev1.NodeSelectorOpIn, Values: archs[os]})
			terms = append(terms, t)
		}
	}
	affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution = &corev1.NodeSelector{NodeSelectorTerms: terms}

	patch, _ := json.Marshal([]map[string]any{{"op": "add", "path": "/spec/affinity", "value": affinity}})
	log.Info("required platforms", "platforms", allowed)
	return patch
}

// constrained reports whether the pod already picks its node or architecture.
// DaemonSet pods are skipped: a pending pod on an unsupported node would stall rollouts.
// An os selector alone doesn't count, since many charts set kubernetes.io/os: linux by default.
func constrained(pod *corev1.Pod) bool {
	if pod.Spec.NodeName != "" {
		return true
	}
	if _, ok := pod.Spec.NodeSelector[archLabel]; ok {
		return true
	}
	for _, o := range pod.OwnerReferences {
		if o.Kind == "DaemonSet" {
			return true
		}
	}
	if a := pod.Spec.Affinity; a != nil && a.NodeAffinity != nil && a.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution != nil {
		for _, t := range a.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms {
			for _, e := range t.MatchExpressions {
				if e.Key == archLabel {
					return true
				}
			}
		}
	}
	return false
}

type resolver struct {
	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	platforms []string
	expires   time.Time // zero for digests
}

func newResolver() *resolver {
	return &resolver{cache: map[string]cached{}}
}

func (r *resolver) platforms(ctx context.Context, image string) ([]string, error) {
	ref, err := name.ParseReference(image)
	if err != nil {
		return nil, err
	}
	key := ref.Name()

	r.mu.Lock()
	c, ok := r.cache[key]
	r.mu.Unlock()
	if ok && (c.expires.IsZero() || time.Now().Before(c.expires)) {
		return c.platforms, nil
	}

	desc, err := remote.Get(ref, remote.WithContext(ctx))
	if err != nil {
		return nil, err
	}
	platforms, err := imagePlatforms(desc)
	if err != nil {
		return nil, err
	}

	c = cached{platforms: platforms}
	if _, digest := ref.(name.Digest); !digest {
		c.expires = time.Now().Add(tagTTL)
	}
	r.mu.Lock()
	if len(r.cache) > 1024 {
		clear(r.cache)
	}
	r.cache[key] = c
	r.mu.Unlock()
	return platforms, nil
}

func imagePlatforms(desc *remote.Descriptor) ([]string, error) {
	var platforms []string
	if desc.MediaType.IsIndex() {
		idx, err := desc.ImageIndex()
		if err != nil {
			return nil, err
		}
		m, err := idx.IndexManifest()
		if err != nil {
			return nil, err
		}
		// skips attestation manifests, which are unknown/unknown
		for _, d := range m.Manifests {
			if p := d.Platform; p != nil && p.OS != "unknown" {
				platforms = append(platforms, p.OS+"/"+p.Architecture)
			}
		}
	} else {
		img, err := desc.Image()
		if err != nil {
			return nil, err
		}
		cfg, err := img.ConfigFile()
		if err != nil {
			return nil, err
		}
		platforms = append(platforms, cfg.OS+"/"+cfg.Architecture)
	}
	if len(platforms) == 0 {
		return nil, errors.New("no platforms")
	}
	slices.Sort(platforms)
	return slices.Compact(platforms), nil
}

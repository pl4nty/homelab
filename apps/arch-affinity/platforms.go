package main

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

// tags can move, digests can't
const tagTTL = 10 * time.Minute

type resolver struct {
	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	archs   []string
	expires time.Time // zero for digests
}

func newResolver() *resolver {
	return &resolver{cache: map[string]cached{}}
}

// archs returns the linux architectures an image supports
func (r *resolver) archs(ctx context.Context, image string) ([]string, error) {
	ref, err := name.ParseReference(image)
	if err != nil {
		return nil, err
	}
	key := ref.Name()

	r.mu.Lock()
	c, ok := r.cache[key]
	r.mu.Unlock()
	if ok && (c.expires.IsZero() || time.Now().Before(c.expires)) {
		return c.archs, nil
	}

	desc, err := remote.Get(ref, remote.WithContext(ctx))
	if err != nil {
		return nil, err
	}
	archs, err := platforms(desc)
	if err != nil {
		return nil, err
	}

	c = cached{archs: archs}
	if _, digest := ref.(name.Digest); !digest {
		c.expires = time.Now().Add(tagTTL)
	}
	r.mu.Lock()
	if len(r.cache) > 1024 {
		clear(r.cache)
	}
	r.cache[key] = c
	r.mu.Unlock()
	return archs, nil
}

func platforms(desc *remote.Descriptor) ([]string, error) {
	var archs []string
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
			if d.Platform != nil && d.Platform.OS == "linux" {
				archs = append(archs, d.Platform.Architecture)
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
		if cfg.OS == "linux" {
			archs = append(archs, cfg.Architecture)
		}
	}
	if len(archs) == 0 {
		return nil, errors.New("no linux platforms")
	}
	slices.Sort(archs)
	return slices.Compact(archs), nil
}

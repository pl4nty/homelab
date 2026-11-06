package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"time"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
)

const archLabel = "kubernetes.io/arch"

type handler struct {
	archs func(ctx context.Context, image string) ([]string, error)
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

// patch returns a JSON patch that requires the architectures every image supports,
// or nil to admit the pod unchanged
func (h *handler) patch(ctx context.Context, namespace string, pod *corev1.Pod) []byte {
	if constrained(pod) {
		return nil
	}
	log := slog.With("namespace", namespace, "pod", pod.GenerateName+pod.Name)

	var allowed []string
	for i, c := range slices.Concat(pod.Spec.InitContainers, pod.Spec.Containers) {
		archs, err := h.archs(ctx, c.Image)
		if err != nil {
			log.Warn("skipped: image lookup failed", "image", c.Image, "err", err)
			return nil
		}
		if i == 0 {
			allowed = archs
		} else {
			allowed = slices.DeleteFunc(slices.Clone(allowed), func(a string) bool { return !slices.Contains(archs, a) })
		}
	}
	if len(allowed) == 0 {
		log.Warn("skipped: images share no architecture")
		return nil
	}

	affinity := pod.Spec.Affinity.DeepCopy()
	if affinity == nil {
		affinity = &corev1.Affinity{}
	}
	if affinity.NodeAffinity == nil {
		affinity.NodeAffinity = &corev1.NodeAffinity{}
	}
	required := affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution
	if required == nil || len(required.NodeSelectorTerms) == 0 {
		required = &corev1.NodeSelector{NodeSelectorTerms: []corev1.NodeSelectorTerm{{}}}
	}
	// terms are ORed, so each one needs the requirement
	expr := corev1.NodeSelectorRequirement{Key: archLabel, Operator: corev1.NodeSelectorOpIn, Values: allowed}
	for i := range required.NodeSelectorTerms {
		required.NodeSelectorTerms[i].MatchExpressions = append(required.NodeSelectorTerms[i].MatchExpressions, expr)
	}
	affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution = required

	patch, _ := json.Marshal([]map[string]any{{"op": "add", "path": "/spec/affinity", "value": affinity}})
	log.Info("required architectures", "archs", allowed)
	return patch
}

// constrained reports whether the pod already picks its node or architecture.
// DaemonSet pods are skipped: a pending pod on an unsupported node would stall rollouts.
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

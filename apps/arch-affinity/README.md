# arch-affinity

Mutating webhook that adds a required `kubernetes.io/os` and `kubernetes.io/arch` node affinity to new pods, set to the platforms that all of the pod's images support. Each os gets its own node selector term. It reads image manifests anonymously and caches them (digests forever, tags for 10 minutes).

It admits a pod unchanged when:

- the pod already sets a node, an arch nodeSelector or an arch affinity (an os selector alone is kept and combined)
- a DaemonSet owns the pod
- an image lookup fails or takes more than 5 seconds
- the images share no platform

The pod creates a self-signed certificate on start and writes it to the webhook's `caBundle`. The webhook uses `failurePolicy: Ignore`, so pods are admitted unchanged while it restarts.

# arch-affinity

Mutating webhook that adds a required `kubernetes.io/arch` node affinity to new pods, set to the linux architectures that all of the pod's images support. It reads image manifests anonymously and caches them (digests forever, tags for 10 minutes).

It admits a pod unchanged when:

- the pod already sets a node, an arch nodeSelector or an arch affinity
- a DaemonSet owns the pod
- an image lookup fails or takes more than 5 seconds
- the images share no architecture

The pod creates a self-signed certificate on start and writes it to the webhook's `caBundle`. The webhook uses `failurePolicy: Ignore`, so pods are admitted unchanged while it restarts.

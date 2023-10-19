# Homelab
My homelab infrastructure-as-code. Built with [✨Kubernetes✨](https://kubernetes.io/) clusters on [Azure](https://learn.microsoft.com/en-us/azure/aks/), [Oracle Cloud](https://docs.oracle.com/en-us/iaas/Content/ContEng/Concepts/contengoverview.htm), and [bare metal](https://www.talos.dev/).

The clusters use [Flux](https://fluxcd.io/) to pull their configuration from YAML files in the `kubernetes` folder. The `base` subfolder applies to all clusters, and other subfolders apply to individual clusters. I also use the following external services:

Networking:
* [Cloudflare authoritative DNS](https://www.cloudflare.com/dns/)
* [Cloudflare Tunnels](https://www.cloudflare.com/products/tunnel/) and [Operator](https://github.com/adyanth/cloudflare-operator) HTTP routing and TLS termination
* [Bunny CDN](https://bunny.net/cdn/) for media, [Cloudflare CDN](https://www.cloudflare.com/cdn/) for everything else
* [Cloudflare Access](https://www.cloudflare.com/products/zero-trust/access/) authentication broker
* [Azure AD](https://www.microsoft.com/microsoft-365/p/microsoft-365-personal/cfq7ttc0k5bf) identity provider

Observability:
* [OpenTelemetry Operator](https://github.com/open-telemetry/opentelemetry-operator) automated tracing
* [Grafana Kubernetes Monitoring](https://github.com/grafana/k8s-monitoring-helm) metric and log exporting
* [Grafana Cloud](https://grafana.com/products/cloud/) storage, analysis, and alerts

GitOps:
* [Mend Renovate](https://www.mend.io/free-developer-tools/renovate/) dependency updates
* [GitHub](https://github.com/) source control
* [Dev Container](https://containers.dev/) development environment
* [Mozilla SOPS](https://github.com/mozilla/sops) secret management
* [age](https://github.com/FiloSottile/age) secret encryption

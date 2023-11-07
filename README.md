# Homelab
My homelab's infrastructure-as-code. Built with ✨[Kubernetes](https://kubernetes.io/)✨ clusters on [Azure](https://learn.microsoft.com/en-us/azure/aks/), [Oracle Cloud](https://docs.oracle.com/en-us/iaas/Content/ContEng/Concepts/contengoverview.htm), and [bare metal](https://www.talos.dev/).

My clusters use [Flux](https://fluxcd.io/) to pull their configuration from YAML files in the `kubernetes` folder. The `base` subfolder applies to all clusters, and other subfolders apply to individual clusters. The files contain most configuration, but I also use some external services:

Networking:
* [Cloudflare authoritative DNS](https://www.cloudflare.com/dns/)
* [Cloudflare Tunnels](https://www.cloudflare.com/products/tunnel/) HTTP routing and TLS termination, with my [Gateway API implementation](https://github.com/pl4nty/cloudflare-kubernetes-gateway) 
* [Cloudflare CDN](https://www.cloudflare.com/cdn/)
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

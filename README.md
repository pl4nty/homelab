# Lab Infrastructure
Configuration files for my lab infrastructure. In future, some files may be added for bootstrapping or point-in-time snapshots.

## Kubernetes 
Kubernetes manifests deployed to clusters with Flux in a pull-only model. Base manifests apply to all clusters, and other folders are cluster-specific.

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
* [Flux](https://fluxcd.io/) manifest reconciliation
* [Mend Renovate](https://www.mend.io/free-developer-tools/renovate/) dependency updates
* [GitHub](https://github.com/) source control and development (Codespaces)
* [Mozilla SOPS](https://github.com/mozilla/sops) secret management
* [age](https://github.com/FiloSottile/age) secret encryption

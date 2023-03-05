# Lab Infrastructure
Configuration files for my lab infrastructure. In future, some files may be added for bootstrapping or point-in-time snapshots.

## Kubernetes 
Kubernetes manifests deployed to clusters with Flux in a pull-only model. Base manifests apply to all clusters, and other folders are cluster-specific.

Networking:
* [Cloudflare authoritative DNS](https://www.cloudflare.com/dns/)
* [Cloudflare Tunnels](https://www.cloudflare.com/products/tunnel/) HTTP routing and TLS termination
* [Traefik](https://github.com/traefik/traefik) internal routing ([Gateway API](https://gateway-api.sigs.k8s.io/)), until I write a [cloudflared](https://github.com/cloudflare/cloudflared) operator
* [Cloudflare Access](https://www.cloudflare.com/products/zero-trust/access/) authentication broker
* [Azure AD](https://www.microsoft.com/microsoft-365/p/microsoft-365-personal/cfq7ttc0k5bf) IdP

Monitoring:
* [Grafana Cloud](https://grafana.com/products/cloud/) metrics, logs, alerts
* [grafana-agent-operator](https://github.com/grafana/agent) metric and log shipping

GitOps:
* [Flux](https://fluxcd.io/) manifest reconciliation
* [Mend Renovate](https://www.mend.io/free-developer-tools/renovate/) dependency updates
* [GitHub](https://github.com/) source control, development (Codespaces)
* [Mozilla SOPS](https://github.com/mozilla/sops) secrets management
* [age](https://github.com/FiloSottile/age) secret encryption

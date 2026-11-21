# Terraform

Root modules for things Flux can't reach, run with OpenTofu. CI plans on PRs (as a PR comment) and applies on `main`.

## github

Settings for every repo in my account, found by search: features, merge options, secret scanning, Dependabot alerts, and Actions permissions. Defaults and per-repo overrides are in `repos.tf`. Descriptions, homepages and topics stay in the GitHub UI.

* `import` blocks adopt every repo on each run, so state is just an Actions cache and losing it is harmless.
* A repo that drops out of search is forgotten (`lifecycle { destroy = false }`), never deleted or archived.
* Archived repos are read-only, so they're tracked but not changed. Archive a repo with an `archived = true` override.

## oracle

The Always Free A1 VM `talos-oci-a1` (`talos/node/talos-oci-a1`): its VCN, firewall, IPv6, and the instance principals the OCI cloud controller and CSI use.

* `import` blocks adopt everything that already exists, so state is just a cache here too. The VCN, subnet and VM can't be destroyed (`prevent_destroy`).
* The VM ignores every change, since nearly any field replaces it and Talos owns it after boot. To make a new one, run `talos/oracle-image.sh` first, then add its `public_ip` output to `talos/topf.yaml` and `talos/node/talos-oci-a1/certsans.yaml`.
* OCI allocates the VCN's IPv6 /56 on apply, so a VCN getting IPv6 needs a second apply for the subnet and VM addresses. Talos reads them at boot, so reboot the node after.
* CI uses an API key (`OCI_*` secrets). Who can reach apid is the `TF_VAR_ADMIN_CIDRS` secret, a JSON list.

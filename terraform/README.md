# Terraform

Root modules for things Flux can't reach, run with OpenTofu. CI plans on PRs (as a PR comment) and applies on `main`.

## github

Settings for every repo in my account, found by search: features, merge options, secret scanning, Dependabot alerts, and Actions permissions. Defaults and per-repo overrides are in `repos.tf`. Descriptions, homepages and topics stay in the GitHub UI.

* `import` blocks adopt every repo on each run, so state is just an Actions cache and losing it is harmless.
* A repo that drops out of search is forgotten (`lifecycle { destroy = false }`), never deleted or archived.
* Archived repos are read-only, so they're tracked but not changed. Archive a repo with an `archived = true` override.

# Terraform

Root modules for things Flux can't reach, run with OpenTofu. CI plans on PRs (as a PR comment) and applies on `main`.

## github

Settings for every repo I own that isn't a fork or archived: features, merge options, secret scanning, Dependabot alerts, and Actions permissions. Defaults and per-repo overrides are in `repos.tf`; `import` blocks adopt a repo the first time it's listed. Descriptions, homepages and topics stay in the GitHub UI.

* New repo: add it to `public` or `private`. Plans warn about unlisted repos.
* Removing a repo from the list archives it (`archive_on_destroy`), it never deletes it.
* State is in the Cloudflare R2 bucket `terraform`.

# apps

One folder per app: source, `Dockerfile`, and `deploy/` manifests. A PR that
changes an app is linted, tested, and deployed as a preview; merging it deploys
to production. See [docs/apps-monorepo.md](../docs/apps-monorepo.md).

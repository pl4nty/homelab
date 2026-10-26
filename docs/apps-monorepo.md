# Apps monorepo

Status: proposal (draft PR). Decided so far: `pl4nty/containers` merges into this
repo; previews come from Flux Operator `OCIArtifactTag`; CI stays lightweight (no
in-CI cluster).

## Goal

One PR changes an app end to end: source, Dockerfile, deployment. It gets lint and
tests in CI and a preview URL on the cluster, and merging it deploys to production
with no second PR.

Today one app change takes two PRs: one in `containers`, then a Renovate digest
bump of `latest@sha256:…` here.

## The ordering problem

A PR can't pin the digest of an image its own CI hasn't built yet. So production
and previews don't read image digests from git. CI builds and tests the image,
then pushes the app's manifests with the digest filled in as a signed OCI
artifact. Flux deploys that artifact. An artifact only exists after its image
does, so the cluster never sees a manifest that points at a missing image.

Third-party apps are unchanged: plain manifests in `kubernetes/`, pinned by
Renovate.

## Layout

```
apps/<app>/
  Dockerfile        # optional; a stage named `test` is run in CI if present
  PLATFORMS         # optional; default linux/amd64,linux/arm64
  deploy/           # optional; manifests, or a kustomization.yaml
  <submodule>/      # optional; upstream source for apps built from another repo
docker-bake.hcl     # one bake definition for every app
kubernetes/         # cluster config and third-party apps (as today)
kubernetes/delivery # Flux Operator, previews and production for apps/ (staged)
talos/
```

`apps/hello` is a sample that exercises the whole pipeline.

### App contract

- Image: `ghcr.io/pl4nty/<app>`, the same names `containers` uses today.
- `deploy/` manifests use `${APP_IMAGE_REPOSITORY}` and `${APP_IMAGE_TAG}` for the
  app's own image. CI replaces only these two. Everything else (`${PUBLIC_DOMAIN}`,
  `${CLUSTER_NAME}`) is left for Flux post-build substitution, as now.
- Hostnames are `<app>${APP_HOST_SUFFIX:=}.${PUBLIC_DOMAIN}`. Previews set the
  suffix to `-pr-<n>`, which stays one level deep for Cloudflare Universal SSL.
- `chartRef` names its namespace (`namespace: default`), because previews run in
  their own namespace.
- Secrets go in `*.sops.yaml` as now. Previews never get them, so an app must start
  without them, or have a preview-safe default.

## CI (`.github/workflows/apps.yaml`)

| Job | PR | main |
|---|---|---|
| `changes` | apps changed against the PR base | apps changed against the previous commit |
| `app` (one per app) | Dockerfile lint (`--call check`), `test` stage, image `pr-<n>`, render + kubeconform `deploy/` | the same, image `sha-<sha>` + `latest`, signed deploy artifact `homelab/deploy/<app>:sha-<sha>`, then tag `main` |
| `preview` | one signed artifact `homelab/previews:pr-<n>` with every changed app's `deploy/` | n/a |
| `ci-ok` | the only check to make required | the same |

- No `paths:` filter. A path-skipped workflow leaves its required check pending
  ([GitHub docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)).
  `changes` costs seconds, and `ci-ok` always reports.
- A change to `docker-bake.hcl`, the workflow or `.github/scripts/` rebuilds every
  app. Unchanged apps should hit the BuildKit cache, but with ~45 apps this is still
  ~45 short jobs. If that is too much, change it to rebuild only `hello`.
- Only `main` writes the `gha` cache (10 GB per repo), so PR builds can't evict it.
- Fork PRs run lint and tests but publish nothing: their token is read-only.
- Bot PRs (Renovate) get tests but no preview.
- Images are built with QEMU for arm64. If that gets slow, switch the builder to the
  Namespace remote builders `containers` uses, or to native `ubuntu-24.04-arm`
  runners.

## Delivery (`kubernetes/delivery/`, staged)

- `base/flux-operator.yaml`: Flux Operator, for `ResourceSet` and
  `ResourceSetInputProvider`. The existing Flux install is untouched: without a
  `FluxInstance` the operator doesn't manage the Flux controllers.
- `oke/previews.yaml`: an `OCIArtifactTag` provider on `homelab/previews`
  (`includeTag: ^pr-[0-9]+$`), and a `ResourceSet` that creates, per tag:
  - namespace `preview-pr-<n>`
  - an `OCIRepository` pinned to the tag's digest and verified with cosign against
    this workflow's PR identity
  - a `Kustomization` with `targetNamespace` and `APP_HOST_SUFFIX`
  ([provider reference](https://fluxoperator.dev/docs/crd/resourcesetinputprovider/)).
- `oke/apps.yaml`: production. A `ResourceSet` with one input per app. Each app gets
  an `OCIRepository` following `homelab/deploy/<app>:main`, verified against the
  `main` branch identity, and a `Kustomization` with SOPS decryption.
- Rollback: `flux tag artifact oci://ghcr.io/pl4nty/homelab/deploy/<app>:sha-<old> --tag main`,
  or revert the commit.

### Why `OCIArtifactTag`, not `GitHubPullRequest`

The PR provider can filter only by labels and branch. It can't wait for CI, and the
documented workaround (a pause label the workflow adds and removes) has a race
([Flux Operator docs](https://fluxoperator.dev/docs/resourcesets/github-pull-requests/)).
With OCI tags, the tag only exists after CI passes. And only this repo's workflow
can sign it, so a fork or anyone else can't get code onto the cluster.

### Preview cleanup (`.github/workflows/previews.yaml`)

When a PR closes, the workflow deletes its `pr-<n>` version. The provider then drops
the input, and the `ResourceSet` deletes the namespace and everything in it. A daily
run deletes versions whose PR is closed, in case a delete failed. Cosign signature
tags left behind are harmless.

## Enabling it

1. Merge this PR. The workflow builds and pushes `hello`. Nothing is deployed yet.
2. Package settings (once per new package): make `hello`, `homelab/previews` and
   `homelab/deploy/hello` public, and give this repo Admin under "Manage Actions
   access" on `homelab/previews`, so the cleanup workflow can delete versions.
   This is from memory of GHCR defaults, so check it on the first push.
3. Apply `kubernetes/delivery/base` with a new Flux `Kustomization`.
4. Allow preview routes. The `${CLUSTER_NAME}` Gateway listener has no
   `allowedRoutes`, so it defaults to `from: Same` and ignores routes in
   `preview-*` namespaces. Either use `from: Selector` on the
   `homelab.tplant.com.au/preview` label (and label `default`), or add a second
   listener. Check what `cloudflare-kubernetes-gateway` supports first.
5. Put previews behind Cloudflare Access (`*-pr-*.${PUBLIC_DOMAIN}`). They run
   unreviewed code.
6. Apply `kubernetes/delivery/oke` with a `Kustomization` that depends on step 3.
   Open a PR that changes `apps/hello` and check `hello-pr-<n>.${PUBLIC_DOMAIN}`.
7. Make `ci-ok` a required check. Consider removing `ignoreTests: true` from
   Renovate, so automerge waits for CI.

Previews go on `cluster-oke` (stateless, public apps). If the single-cluster plan
happens, they move to the Oracle worker.

## Migrating `containers`

1. Rewrite its history into `apps/`:
   `git filter-repo --to-subdirectory-filter apps`. Then here run
   `git merge --allow-unrelated-histories`. Each app's history is kept.
2. Rewrite `.gitmodules` paths (`<app>/<app>` → `apps/<app>/<app>`). Keep
   `GH_PAT` for the private submodules.
3. Move first-party HelmReleases from `kubernetes/oke/<app>.yaml` to
   `apps/<app>/deploy/`, switch the image to the placeholders, and add the app to
   `oke/apps.yaml`. Do one app first (stickers, scratch PR #7, is a good pilot).
4. Each existing `ghcr.io/pl4nty/<app>` package is linked to `containers`. Grant
   this repo write access under "Manage Actions access", or pushes fail with 403.
5. Windows images (the `PLATFORMS` files that contain `windows`) need the Windows
   job from `containers/release.yaml`. It isn't ported here yet.
6. Archive `containers` after the last app moves.

## Open risks

- **Cosign signature format.** `cosign-installer` v4 may install cosign v3, which
  writes Sigstore bundles. Check that Flux's `verify` (source-controller from Flux
  v2.9.6) accepts them before enabling. If it doesn't, sign with
  `--new-bundle-format=false`, or drop `verify` for now.
- **Blast radius.** App CI with `packages: write` sits in the same repo as the Talos
  and SOPS config. Mitigations:
  - The workflow has no secrets beyond `GITHUB_TOKEN`.
  - Flux only reads `/kubernetes`, through the `GitRepository` `ignore` rule.
  - Add CODEOWNERS for `talos/` and `kubernetes/`.
- **One preview per PR, not per app.** A PR touching two apps gets both in one
  namespace. This is simpler, but a broken app fails the whole preview
  `Kustomization` (`wait: true`).
- **Stateful apps.** A preview gets an empty database or volume, never production
  data.

## Alternatives considered

- **Keep `containers` separate and move only `deploy/` folders there.** That keeps
  infra and app CI apart, but a PR that needs infra (a CNPG cluster, a PVC class)
  still needs a second PR here.
- **Flux image automation** writing digests back to git. It works with any
  layout, but adds bot commits and brings back the controllers deleted in
  `flux-config.yaml`.
- **Test in a `kind` cluster in CI.** It catches broken charts before the preview
  does, but costs minutes on every PR. Rejected: CI stays lightweight, and the
  preview is the integration test.

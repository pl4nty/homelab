# Apps monorepo

Status: proposal. Decided so far:
- `pl4nty/containers` merges into this repo under `apps/`.
- Previews come from Flux Operator `OCIArtifactTag`.
- CI stays lightweight: no in-CI cluster, and no custom scripts.

## Goal

One PR changes an app end to end: source, Dockerfile and deployment. The PR is
built and tested, and gets a preview URL. Merging it deploys to production. Today
the same change takes two PRs: one in `containers`, then a Renovate digest bump here.

## How

A PR can't pin the digest of an image its own CI hasn't built yet. So the
cluster doesn't read app manifests from git. For each changed app, CI:

1. builds the image, tagged `sha-<commit>`;
2. writes that tag into the app's `deploy/` folder;
3. pushes the folder, signed, to `ghcr.io/pl4nty/homelab/apps/<app>`, tagged
   `pr-<n>` or `main`.

Flux deploys only those artifacts, so it never sees a manifest whose image doesn't
exist yet. Third-party apps don't change: they stay in `kubernetes/`, pinned by
Renovate.

## App contract

```
apps/<app>/
  Dockerfile   # tests are stages the final stage copies from, so a build is a test
  deploy/      # manifests; image tag: ${APP_IMAGE_TAG}
```

- The image is `ghcr.io/pl4nty/<app>`, the same name `containers` uses today.
- Hostnames are `<app>${APP_HOST_SUFFIX:=}.${PUBLIC_DOMAIN}`. Previews set the
  suffix to `-pr-<n>`, which stays one level deep for Cloudflare Universal SSL.
- `chartRef` names its namespace (`namespace: default`), because each preview runs
  in its own namespace.
- Previews never get `*.sops.yaml`. An app needs a preview-safe default for any
  secret it uses.

`apps/hello` is the sample.

## CI

`.github/workflows/apps.yaml`. The build is one bake target (`docker-bake.hcl`).

| Event | Per changed app |
|---|---|
| PR | Dockerfile lint, build + test, push the image and `apps/<app>:pr-<n>` |
| merge to main | the same, then `apps/<app>:main` |
| PR closed | delete `apps/<app>:pr-<n>` (`ghcr-cleanup-action`) |

- Changed apps come from `tj-actions/changed-files`, the same action and
  SHA pin as `containers`.
- `ci-ok` (`re-actors/alls-green`) is the only check to make required. A
  path-filtered workflow would leave required checks pending
  ([GitHub docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)).
- Fork PRs build but don't publish.
- Only `main` writes the `gha` cache.

## Delivery (`kubernetes/delivery/`, staged)

- `base/`: Flux Operator, used only for `ResourceSet`. The existing Flux install is
  untouched.
- `oke/apps.yaml`: one `ResourceSet` that gives each app in its list three things:
  - an `OCIRepository` on `:main`, cosign-verified against the `main` branch
    identity of the workflow
  - a `Kustomization` that decrypts SOPS secrets
  - an `OCIArtifactTag` provider for its `pr-<n>` tags

  A second `ResourceSet` turns each provider input into a preview: a namespace
  `<app>-pr-<n>`, an `OCIRepository` pinned to the digest and verified against
  the PR identity, and a `Kustomization`.
- Why `OCIArtifactTag`: a tag only exists after CI passes. `GitHubPullRequest`
  can't wait for CI, and the workaround its docs describe has a race
  ([Flux Operator](https://fluxoperator.dev/docs/resourcesets/github-pull-requests/)).
- Rollback: revert the commit. The revert's build moves `:main` back.

## Enabling

1. Merge. CI publishes `hello`. Nothing deploys yet.
2. GHCR, once per new package:
   - Make `hello` and `homelab/apps/hello` public.
   - Under "Manage Actions access" on `homelab/apps/*`, give this repo Admin, so
     the cleanup job can delete tags.
3. Apply `kubernetes/delivery/base`.
4. Let the Gateway accept routes from preview namespaces. The listener has no
   `allowedRoutes`, so it defaults to `from: Same`.
5. Put Cloudflare Access in front of `*-pr-*` hostnames.
6. Apply `kubernetes/delivery/oke`. Make `ci-ok` required.

## Migrating `containers`

1. `git filter-repo --to-subdirectory-filter apps` in `containers`, then
   `git merge --allow-unrelated-histories` here. This keeps history.
2. Fix the `.gitmodules` paths.
3. Move first-party HelmReleases from `kubernetes/oke/` into `apps/<app>/deploy/`,
   then add each app to `oke/apps.yaml`. Pilot with one app.
4. Give this repo write access to each existing `ghcr.io/pl4nty/<app>` package.
5. Port the Windows build path for the 2 Windows images.
6. Archive `containers`.

## Risks

- **Cosign format.** Check that Flux v2.9.6 `verify` accepts what cosign from
  `cosign-installer` v4 writes. If it doesn't, drop `verify` until it does.
- **Same-repo PRs can edit the workflow.** Production verifies the `main` identity,
  so a PR can't publish to production. Previews still run code from any PR, so keep
  them behind Access.
- **A PR whose later commits revert an app change** leaves that app's preview
  until the PR closes.
- **Stateful apps** get empty storage in previews.

## Alternatives considered

- **Keep `containers` and move only `deploy/` there.** Infra changes would still
  need a PR here.
- **Flux image automation** writing digests to git. This brings back controllers
  you deleted, and adds bot commits.
- **A `kind` test in CI.** Rejected to keep CI light; the preview is the
  integration test.

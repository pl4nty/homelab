# Staged: apps/ delivery

Nothing in this folder is applied yet. No Flux `Kustomization` points here, so the
Flux Operator CRDs these files need don't have to exist.

Enable it in this order (see `docs/apps-monorepo.md`):

1. Apply `base/` (Flux Operator) on the cluster, for example by adding a
   `Kustomization` for `./kubernetes/delivery/base`.
2. Let previews' HTTPRoutes attach: the `${CLUSTER_NAME}` Gateway listener
   defaults to `from: Same`, so routes in preview namespaces (labelled
   `homelab.tplant.com.au/preview`) are ignored.
3. Make the `homelab/apps/*` packages public, or add a
   `secretRef` to the providers and OCIRepositories.
4. Add a `Kustomization` for `./kubernetes/delivery/oke` that depends on step 1.

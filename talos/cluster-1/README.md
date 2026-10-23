# cluster-1 Talos config

Machine configs are rendered by [topf](https://github.com/postfinance/topf) from:

- `topf.yaml`: nodes, Talos/Kubernetes versions, schematic per node
- `schematics/`: [Image Factory](https://factory.talos.dev) schematics (extensions, SBC overlay)
- `all/`, `control-plane/`, `worker/`, `node/<host>/`: strategic merge patches, applied in that order
- `secrets.yaml`: `talosctl gen secrets` bundle, SOPS-encrypted with the repo's age key

Rendered configs (`output/`) are never committed.

## Migrating from the full configs in `../`

`../controlplane.yaml` and `../worker-rk1.yaml` are stale (Talos 1.8/1.9, Kubernetes 1.32). Nodes run Talos 1.11.1 and Kubernetes 1.34.2.

1. Import the **existing** secrets from the live control plane. Do not let topf generate new secrets: a new PKI would lock the nodes out.

   ```sh
   talosctl -n 192.168.1.131 get machineconfig -o jsonpath='{.spec}' > /tmp/cp.yaml
   talosctl gen secrets --from-controlplane-config /tmp/cp.yaml -o secrets.yaml
   rm /tmp/cp.yaml
   sops -e -i secrets.yaml
   ```

2. Compare the schematics with the extensions on the nodes. Edit `schematics/` until they match, because `topf upgrade` reinstalls any node whose schematic is different:

   ```sh
   talosctl -n 192.168.1.131,192.168.1.133,192.168.1.134 get extensions
   ```

3. Register new schematics with the factory once:

   ```sh
   topf schematic-ids --submit-to-factory
   ```

4. Check for drift and fix the patches until the diff is empty (or contains only changes you want):

   ```sh
   topf apply --dry-run
   ```

5. Delete `../controlplane.yaml`, `../worker.yaml`, `../worker-rk1.yaml` and `../talosconfig.yaml` (get a new one with `topf talosconfig`).

## Day-2

```sh
topf apply      # config changes
topf upgrade    # Talos version or schematic changes
```

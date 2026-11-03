# rockchip-mpp extension

## Installation

See [Installing Extensions](https://github.com/siderolabs/extensions#installing-extensions).
The modules aren't signed with the Talos key, so the installer also needs
`--extra-kernel-arg -module.sig_enforce`.

## Usage

The modules don't autoload: load `rk_vcodec` (`/dev/mpp_service`) and `rga3` (`/dev/rga`).

```yaml
apiVersion: v1alpha1
kind: KernelModuleConfig
name: rk_vcodec
---
apiVersion: v1alpha1
kind: KernelModuleConfig
name: rga3
```

## Verifying

```bash
❯ talosctl -n <node> read /proc/modules
rga3 ... - Live ... (OE)
rk_vcodec ... - Live ... (OE)
rk3588_mpp_dt ... - Live ... (OE)
vsi_iommu ... - Live ... (OE)
❯ talosctl -n <node> ls /dev | grep -E 'mpp_service|rga'
```

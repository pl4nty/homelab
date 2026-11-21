# rockchip-mpp extension

## Installation

See [Installing Extensions](https://github.com/siderolabs/extensions#installing-extensions).
The modules aren't signed with the Talos key, so the installer also needs
`--extra-kernel-arg -module.sig_enforce`. With `rockchip-rknn` installed, also pass
`--extra-kernel-arg module_blacklist=rocket`, or rocket binds the NPU before rknpu.

## Usage

The modules don't autoload: load `rk_vcodec` (`/dev/mpp_service`), `rga3` (`/dev/rga`) and
`rknpu` (the NPU's DRM render node).

```yaml
apiVersion: v1alpha1
kind: KernelModuleConfig
name: rk_vcodec
---
apiVersion: v1alpha1
kind: KernelModuleConfig
name: rga3
---
apiVersion: v1alpha1
kind: KernelModuleConfig
name: rknpu
```

## Verifying

```bash
❯ talosctl -n <node> read /proc/modules
rga3 ... - Live ... (OE)
rk_vcodec ... - Live ... (OE)
rknpu ... - Live ... (OE)
rk3588_mpp_dt ... - Live ... (OE)
vsi_iommu ... - Live ... (OE)
❯ talosctl -n <node> ls /dev | grep -E 'mpp_service|rga'
```

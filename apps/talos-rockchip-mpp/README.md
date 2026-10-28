# rockchip-mpp for Talos

Rockchip's MPP (`/dev/mpp_service`) and RGA (`/dev/rga`) drivers, ported from
the Rockchip BSP kernel to the mainline kernel Talos ships, as a Talos system
extension. They give RK3588 boards (Turing RK1 here) the hardware video
decoders and encoders that Jellyfin's RKMPP transcoding uses, without a BSP
kernel.

**Status: builds against the released Talos v1.14.4 kernel, and every imported symbol version matches it; not yet run on hardware.**

## What's in it

| Module | Device | Blocks |
| --- | --- | --- |
| `rk_vcodec` | `/dev/mpp_service` | rkvdec2 ×2 (H.264, HEVC, VP9), rkvenc2 ×2 (H.264, HEVC), AV1 decoder, VDPU/VEPU 121, JPEG decoder, IEP2 |
| `rga3` | `/dev/rga` | RGA3 ×2, RGA2 |
| `vsi_iommu` | | the Verisilicon IOMMU in front of the AV1 decoder |
| `rk3588_mpp_dt` | | the device tree nodes for all of the above |

Not ported: the JPEG encoder cores.

`vsi-iommu` is the mainline driver from Linux 7.3 (`torvalds/linux` `4da9ded`),
unchanged. The vendor AV1 decoder only uses the DMA API through it, as mainline's
hantro does. `rk3588_mpp_dt` depends on it through an exported symbol, so it loads before
the AV1 decoder's node is added. Otherwise a codec that probes after the
deferred-probe timeout, and finds no IOMMU driver, binds without one.

## How it works on mainline

- **Source**: the build downloads
  [armbian/linux-rockchip](https://github.com/armbian/linux-rockchip) `rk-6.12-rkr1`
  at `6bdc00d`, takes `drivers/video/rockchip/{mpp,rga3}` and the vendor headers
  they include from it, and applies `rockchip-mpp-pkg/patches`. Those patches are
  every change made to the vendor code for mainline. `rockchip-mpp-pkg/src` holds
  the files written for the port and is copied on top: the build files, two
  headers, IOMMU shims and the device tree module. `vsi-iommu.c` comes from
  git.kernel.org at a pinned commit.
- **Vendor kernel APIs**: the vendor headers declare stubs when their vendor
  Kconfig options are off, as they are here, for the OPP, IPA, system monitor,
  DDR DVFS and TF-A calls. Two are replaced in `rockchip-mpp-pkg/src/compat`:
  `pm_domains.h`, whose vendor version declares functions mainline's power domain
  driver doesn't export, and `rockchip_iommu.h`, for the IOMMU shims. Encoder DVFS
  is compiled out, and the blocks run at the fixed rates from the device tree.
- **IOMMU**: the codec IOMMUs run on the mainline `rockchip-iommu` driver, which
  powers them through the device link to the codec and restores the page tables
  on resume. The vendor's explicit IOMMU disable, enable and force-reset calls
  run the IOMMU's runtime PM callbacks. Since Linux 6.15 a DMA API domain can't carry a fault handler, so
  page faults are only logged by the IOMMU driver. The private dma-iommu cookie
  layout the decoder needs to reserve its fixed RCB IOVA window is updated for
  6.15+.
- **Device tree**: the board DTB has no nodes for these blocks, and isn't built
  with `__symbols__`. When `rk3588_mpp_dt` loads, it adds `/__symbols__` entries for
  the three nodes it refers to (`cru`, `power`, `vpu121_mmu`), then applies the
  overlay in `rockchip-mpp-pkg/src/dt/rk3588-mpp.dtso`. That overlay holds the vendor
  nodes, translated to mainline: 4-cell GIC specifiers, mainline IOMMU
  compatibles, `rockchip,core-id` in place of aliases, and no vendor OPP tables.
  It disables mainline's hantro `vpu121` and `rga` nodes for the same blocks. The
  overlay stays applied until reboot, because the mainline IOMMU driver can't
  unbind.
- **Signing**: Talos signs modules with a key it throws away after its build, so
  these modules can't carry a signature Talos trusts. Talos v1.14's kernel
  enforces signatures only through the `module.sig_enforce=1` boot argument, so
  the installer drops it with `-module.sig_enforce`. Talos v1.11's kernel has
  `CONFIG_MODULE_SIG_FORCE=y`, so it can't load the modules at all.

## Layout and build

It follows [siderolabs/extensions](https://github.com/siderolabs/extensions)
and Sidero's [system extension guide](https://docs.siderolabs.com/talos/v1.14/build-and-extend-talos/custom-images-and-development/building-a-system-extension),
except that it doesn't build a kernel. The modules run on the released Talos
kernel, so they can't be signed with its key.

| Stage | Like | What it does |
| --- | --- | --- |
| `kernel-tree` | pkgs `kernel-build` | Linux 6.18.57 source and `modules_prepare` with Sidero's LLVM image. The config (`CONFIG_IKCONFIG`) and `Module.symvers` come from the released `ghcr.io/siderolabs/kernel` image. `symvers.py` reads the export tables and CRCs out of its `Image`, and checks them against the `__versions` of the kernel's own modules. |
| `rockchip-mpp-pkg` | pkgs `gasket-driver-pkg` | downloads and patches the vendor drivers, and builds the modules into `/usr/lib/modules/<release>/extras` |
| `rockchip-mpp` | extensions `drivers/gasket` | the extension: `manifest.yaml.tmpl`, `vars.yaml`, and `extensions-validator` |

`PKGS`, `TOOLS` and `ABBREV_TAG` in `docker-bake.hcl` pin Talos v1.14.4, as in
siderolabs/extensions v1.14.4. CI pushes `ghcr.io/pl4nty/talos-rockchip-mpp:sha-<commit>`.
To build the extension rootfs and manifest locally, from the repository root:

```sh
APP=talos-rockchip-mpp docker buildx bake -f apps/docker-bake.hcl -f apps/talos-rockchip-mpp/docker-bake.hcl \
  --set default.output=type=local,dest=_out
```

## Install (one RK1 first)

1. Build an installer with the released imager. The extension needs no custom
   kernel, but the node must boot without signature enforcement:

   ```sh
   docker run --rm -t -v $PWD/_out:/out ghcr.io/siderolabs/imager:v1.14.4 installer --arch arm64 \
     --overlay-image ghcr.io/siderolabs/sbc-rockchip:<tag for v1.14.4> --overlay-name turingrk1 \
     --system-extension-image ghcr.io/siderolabs/iscsi-tools:<tag for v1.14.4> \
     --system-extension-image ghcr.io/siderolabs/util-linux-tools:<tag for v1.14.4> \
     --system-extension-image ghcr.io/pl4nty/talos-rockchip-mpp:<tag> \
     --extra-kernel-arg -module.sig_enforce
   ```

   `ghcr.io/siderolabs/extensions:v1.14.4` lists the official extension tags
   for v1.14.4.

2. Load the modules. They don't autoload, because their device tree nodes only
   exist once `rk3588_mpp_dt` has loaded. Module dependencies load `vsi_iommu`
   and `rk3588_mpp_dt` first.

   ```yaml
   apiVersion: v1alpha1
   kind: KernelModuleConfig
   name: rk_vcodec
   ---
   apiVersion: v1alpha1
   kind: KernelModuleConfig
   name: rga3
   ```

3. Upgrade one RK1 to that installer, with a serial console attached. Talos
   upgrades one minor version at a time, so a v1.11 node goes through v1.12 and
   v1.13 first.

## Test plan

On the node:

```sh
talosctl -n <rk1> dmesg | grep -E 'mpp|rkvdec|rkvenc|rga|iommu'
talosctl -n <rk1> ls /dev | grep -E 'mpp_service|rga|dma_heap|dri'
talosctl -n <rk1> read /proc/mpp_service/supports-device
```

Then in a privileged pod with `jellyfin/jellyfin` on that node:

```sh
/usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -init_hw_device rkmpp=hw -filter_hw_device hw \
  -c:v hevc_rkmpp -i <hevc file> -vf scale_rkrga=w=1280:h=720:format=nv12 \
  -c:v h264_rkmpp -b:v 4M -f null -
```

## Upstream status

Where each block stands in mainline, as of October 2026:

| Block | Mainline | Usable by Jellyfin |
| --- | --- | --- |
| H.264/HEVC decode (rkvdec2, "VDPU381") | V4L2 stateless, merged for Linux 7.0 | no: jellyfin-ffmpeg has no V4L2 request API support |
| AV1 decode (VPU981) | hantro V4L2 stateless; `vsi-iommu` merged by 7.3 | no, as above |
| H.264/HEVC encode (rkvenc2, VEPU580) | none. RK3576 VEPU510 H.264 RFC (July 2026); uAPI undecided | no |
| RGA3 | V4L2 m2m series at v7 (May 2026), scaling and colour conversion only | no: Jellyfin uses librga |
| RGA2 | `rockchip-rga` V4L2 m2m driver | no, as above |

Jellyfin's RKMPP path needs the vendor `/dev/mpp_service` and `/dev/rga` ABI
whichever kernel drivers exist, and mainline isn't adding those. So this port
has to keep up with mainline until jellyfin-ffmpeg supports the V4L2 decoders
and an encoder lands.

## Known risks

Each of these needs checking on hardware:

- **Codec reset**: after a hardware reset, the vendor driver disables and
  re-enables the codec's IOMMU. Here that runs the mainline IOMMU driver's
  runtime PM suspend and resume through `pm_runtime_force_suspend()` and
  `pm_runtime_force_resume()`, the same path system sleep uses. That force-resets
  the MMU and reprograms the page table. vdpu and vepu share an IOMMU, so a reset
  of one briefly stops the other, as on the BSP.
- **Vendor IOMMU options**: `rockchip,enable-cmd-retry` and
  `rockchip,shootdown-entire` from the vendor IOMMU nodes have no mainline
  equivalent and are dropped.
- **Buffer allocation**: userspace MPP allocates from `/dev/dma_heap/system`,
  which is the only heap mainline has. It is cached memory, so every buffer is
  synced on map. That is correct but slower than the vendor's uncached DMA32
  heaps.
- **Module unloading**: the overlay can't be removed, because the mainline IOMMU
  driver can't unbind. Reload the modules by rebooting.
- **RGA user pointers**: for user memory `get_user_pages` can't pin, the vendor
  driver walks the page tables with `__pte_offset_map_lock()`, which mainline
  doesn't export. Here it uses `follow_pfnmap_start()` instead, which accepts
  only `VM_IO`/`VM_PFNMAP` mappings.

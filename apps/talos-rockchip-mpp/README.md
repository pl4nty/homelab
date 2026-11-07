# rockchip-mpp for Talos

Rockchip's MPP (`/dev/mpp_service`) and RGA (`/dev/rga`) drivers, ported from
the Rockchip BSP kernel to the mainline kernel Talos ships, as a Talos system
extension. They give the Turing RK1s the RK3588 hardware video decoders and
encoders that Jellyfin's RKMPP transcoding uses.

| Module | Device | Blocks |
| --- | --- | --- |
| `rk_vcodec` | `/dev/mpp_service` | rkvdec2 ×2 (H.264, HEVC, VP9), rkvenc2 ×2 (H.264, HEVC), AV1 decoder, VDPU/VEPU 121, JPEG decoder, IEP2 |
| `rga3` | `/dev/rga` | RGA3 ×2, RGA2 |
| `vsi_iommu` | | the Verisilicon IOMMU in front of the AV1 decoder |

The JPEG encoder cores aren't ported.

## How it works

- **Source**: the build downloads [rockchip-linux/kernel](https://github.com/rockchip-linux/kernel)
  `develop-6.12`, takes `drivers/video/rockchip/{mpp,rga3}` and the vendor headers
  they include, and applies `rockchip-mpp-pkg/patches`, which are every change
  to the vendor code. `rockchip-mpp-pkg/src` (build files, two headers, IOMMU
  shims) is copied on top. `vsi-iommu.c` is the mainline driver from Linux 7.3,
  unchanged. `rk_vcodec` references a symbol it exports, so it loads first and
  the AV1 decoder doesn't bind without an IOMMU.
- **Vendor kernel APIs**: with their vendor Kconfig options off, the vendor
  headers stub out the OPP, IPA, system monitor, DDR DVFS and TF-A calls.
  `src/compat` replaces `pm_domains.h`, which declares functions mainline
  doesn't export, and `rockchip_iommu.h`. The blocks run at the device tree's
  fixed rates.
- **IOMMU**: the codec IOMMUs run on mainline's `rockchip-iommu`. The vendor's
  IOMMU disable, enable and force-reset calls run its runtime PM callbacks. Since
  Linux 6.15, page faults are only logged.
- **Device tree**: the board DTB has no nodes for these blocks. `rockchip-mpp-pkg/dt/rk3588-mpp.dtsi`
  holds the vendor nodes, translated to mainline. The extension ships it
  preprocessed in `/usr/local/share/rockchip-mpp`, and `talos/Dockerfile`
  compiles it into the DTB the sbc-rockchip overlay installs. Linux 7.x DTBs
  already have four of its IOMMUs and both SRAM pools, under the same node
  names, so those merge.
- **Signing**: Talos throws its module signing key away, so the installer boots
  with `-module.sig_enforce`. Talos v1.11 and older force signatures and can't
  load these modules.

## Build

It follows [siderolabs/extensions](https://github.com/siderolabs/extensions),
except that it doesn't build a kernel.

| Stage | What it does |
| --- | --- |
| `kernel-tree` | Linux source and `modules_prepare` with Sidero's LLVM. The config and `Module.symvers` come from the released `ghcr.io/siderolabs/kernel`: `symvers.py` reads the export tables and CRCs out of its `Image`, and checks them against its own modules. |
| `rockchip-mpp-pkg` | downloads, patches and builds the modules, and preprocesses the device tree nodes |
| `rockchip-mpp` | the extension |

`docker-bake.hcl` pins Talos v1.14.5's `PKGS` and `TOOLS`. CI pushes
`ghcr.io/pl4nty/talos-rockchip-mpp:sha-<commit>`, and tags main's build with its
Talos version.

## Install

`talos/docker-bake.hcl` builds the RK1 installer from `talos/hardware/rk1-schematic.yaml`,
which pins the extension by digest, so a rebuild gets a new installer. topf
installs it, and `talos/control-plane/rk1.yaml` loads `rk_vcodec` and `rga3`.

On d04, Jellyfin transcodes fully in hardware: hevc_rkmpp decode, overlay_rkrga
subtitle burn-in and h264_rkmpp encode, at 4–7x realtime for 1080p HEVC Main 10.
Mainline has only the `system` dma-heap, so `kubernetes/cluster-1/arr/jellyfin.yaml`
mounts it under the other names MPP checks for. For about 10 minutes after the
modules first loaded, every rkvdec2 job timed out (`err 0x23`); the cause is
unknown. Decode only ever runs on rkvdec core0.

Mainline has V4L2 decoders for these blocks, but jellyfin-ffmpeg can't use them
and there's no mainline encoder, so the port is needed until both change.

## Known risks

- **Codec reset**: resetting a codec force-suspends and resumes its IOMMU, which
  stops the other codec sharing it (vdpu and vepu), as on the BSP.
- **Dropped IOMMU options**: `rockchip,enable-cmd-retry` and `rockchip,shootdown-entire`
  have no mainline equivalent.
- **Buffers**: MPP allocates from the cached `system` heap, so every buffer is
  synced on map.
- **rkvdec core1**: the nodes keep the vendor address `fdc48000`; mainline uses `fdc40000`.
- **Boot DTB**: a bad node affects boot, not just the modules. Upgrade one node first.
- **RGA user pointers**: memory `get_user_pages` can't pin goes through
  `follow_pfnmap_start()`, which accepts only `VM_IO`/`VM_PFNMAP` mappings.

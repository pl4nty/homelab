# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# The installer Image Factory would build from hardware/rk1-schematic.yaml, if it took unofficial extensions
ARG TALOS_VERSION

FROM --platform=$BUILDPLATFORM busybox:1.37.0-musl AS busybox
FROM --platform=$BUILDPLATFORM gcr.io/go-containerregistry/crane:v0.22.1 AS crane

FROM --platform=$BUILDPLATFORM mikefarah/yq:4.47.2 AS profile
ARG SCHEMATIC_ID
# as Image Factory adds, so topf upgrade can tell the node is current
COPY <<EOF schematic/manifest.yaml
version: v1alpha1
metadata:
  name: schematic
  version: ${SCHEMATIC_ID}
  author: pl4nty
  description: topf schematic ID
  compatibility:
    talos:
      version: ">= 1.0.0"
EOF
COPY <<EOF schematic/rootfs/usr/local/share/schematic/${SCHEMATIC_ID}
EOF
COPY hardware/rk1-schematic.yaml .
RUN <<EOF
tar -cf schematic.tar -C schematic .
yq '.overlay.image' rk1-schematic.yaml > overlay.ref
yq '.customization.systemExtensions.officialExtensions[] | select(test("/talos-rockchip-mpp:"))' rk1-schematic.yaml > mpp.ref
yq '{
  "baseProfileName": "installer",
  "arch": "arm64",
  "overlay": {"name": .overlay.name, "image": {"imageRef": .overlay.image}},
  "input": {
    "overlayInstaller": {"tarballPath": "/overlay.tar"},
    "systemExtensions": [.customization.systemExtensions.officialExtensions[] | {"imageRef": .}] + [{"tarballPath": "/profile/schematic.tar"}]
  },
  "customization": {"extraKernelArgs": .customization.extraKernelArgs}
}' rk1-schematic.yaml > profile.yaml
EOF

# the overlay for the installer, with rockchip-mpp's device tree nodes compiled into the DTB it installs
FROM --platform=$BUILDPLATFORM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS overlay
RUN apk add --no-cache dtc
RUN --mount=from=crane,source=/ko-app/crane,target=/bin/crane --mount=from=profile,source=/workdir,target=/profile <<EOF
set -euo pipefail
mkdir /overlay /mpp
crane export --platform linux/arm64 "$(cat /profile/overlay.ref)" - | tar -x -C /overlay
crane export --platform linux/arm64 "$(cat /profile/mpp.ref)" - | tar -x -C /mpp
dtb=/overlay/artifacts/arm64/dtb/rockchip/rk3588-turing-rk1.dtb
{ dtc -q -I dtb -O dts "$dtb"; cat /mpp/rootfs/usr/local/share/rockchip-mpp/rk3588-mpp.dtsi; } | dtc -q -I dts -O dtb -o /rk1.dtb -
mv /rk1.dtb "$dtb"
tar -cf /overlay.tar -C /overlay .
EOF

# imager has no shell to read the profile from stdin
FROM --platform=$BUILDPLATFORM ghcr.io/siderolabs/imager:${TALOS_VERSION} AS imager
RUN --mount=from=busybox,source=/bin/busybox,target=/bin/sh --mount=from=profile,source=/workdir,target=/profile \
  --mount=from=overlay,source=/overlay.tar,target=/overlay.tar \
  imager - < /profile/profile.yaml

FROM busybox AS installer
RUN --mount=from=crane,source=/ko-app/crane,target=/bin/crane --mount=from=imager,source=/out,target=/out \
  mkdir /rootfs && crane export - - < /out/installer-arm64.tar | tar -x -C /rootfs

FROM scratch
COPY --from=installer /rootfs /
ENTRYPOINT ["/bin/installer"]

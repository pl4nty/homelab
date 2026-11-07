# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# The installer Image Factory would build from hardware/rk1-schematic.yaml, if it took unofficial extensions
ARG TALOS_VERSION

FROM --platform=$BUILDPLATFORM busybox:1.37.0-musl AS busybox
FROM --platform=$BUILDPLATFORM gcr.io/go-containerregistry/crane:v0.22.1 AS crane

FROM --platform=$BUILDPLATFORM mikefarah/yq:4.53.6@sha256:cfc4eee658595834ef304eadb0c3ea721f3b7cb6404ad8b7cb909cc5b5145b23 AS profile
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
yq '{
  "baseProfileName": "installer",
  "arch": "arm64",
  "overlay": {"name": .overlay.name, "image": {"imageRef": .overlay.image}},
  "input": {
    "overlayInstaller": {"imageRef": .overlay.image},
    "systemExtensions": [.customization.systemExtensions.officialExtensions[] | {"imageRef": .}] + [{"tarballPath": "/profile/schematic.tar"}]
  },
  "customization": {"extraKernelArgs": .customization.extraKernelArgs}
}' rk1-schematic.yaml > profile.yaml
EOF

# imager has no shell to read the profile from stdin
FROM --platform=$BUILDPLATFORM ghcr.io/siderolabs/imager:${TALOS_VERSION} AS imager
RUN --mount=from=busybox,source=/bin/busybox,target=/bin/sh --mount=from=profile,source=/workdir,target=/profile \
  imager - < /profile/profile.yaml

FROM busybox AS installer
RUN --mount=from=crane,source=/ko-app/crane,target=/bin/crane --mount=from=imager,source=/out,target=/out \
  mkdir /rootfs && crane export - - < /out/installer-arm64.tar | tar -x -C /rootfs

FROM scratch
COPY --from=installer /rootfs /
ENTRYPOINT ["/bin/installer"]

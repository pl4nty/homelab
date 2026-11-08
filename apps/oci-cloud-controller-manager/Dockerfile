# Upstream's Dockerfile plus these patches (diffs without docs); drop each once a release includes the fix:
# - node-filter.patch, oracle/oci-cloud-controller-manager#544 (--node-filter-requirements), so the CCM only
#   reconciles Oracle nodes in this mixed cluster
# - node-lookups.patch, ours: getNodeIpFamily and getCompartmentIDByInstanceID gave up on the first node
#   without an OCI provider ID, including the node being initialised, so nodes never got one (#522). They now
#   skip non-OCI nodes, find the uninitialised node by name, and read the compartment from the instance
# The Makefile defaults ARCH to amd64, so cross-compile per TARGETARCH rather than build under QEMU
FROM --platform=$BUILDPLATFORM golang:1.27.2@sha256:820153096fda4de6ac1b7194d12e416b7dd8f4e9a33d17e0345b111b945162d8 AS builder
ARG TARGETARCH VERSION
WORKDIR /go/src/github.com/oracle/oci-cloud-controller-manager
COPY --from=src . .
COPY *.patch /tmp/
RUN git apply /tmp/*.patch && make build ARCH="$TARGETARCH" VERSION="$VERSION" BUILD="$VERSION"

FROM ghcr.io/oracle/oraclelinux:8-slim-fips@sha256:bdf2c4b2dd2fec6a656c78606cd1efa13c1c739e9c3e5f7daf7405eb9ce74602
RUN microdnf -y install util-linux e2fsprogs xfsprogs python2 && \
    microdnf update && \
    microdnf clean all
COPY --from=src --chmod=755 scripts/encrypt-mount scripts/encrypt-umount scripts/rpm-host scripts/chroot-bash /sbin/
COPY --from=src image/ /usr/local/bin/
COPY --from=builder /go/src/github.com/oracle/oci-cloud-controller-manager/dist/ /usr/local/bin/

# Upstream's Dockerfile plus oracle/oci-cloud-controller-manager#544 (--node-filter-requirements), so the
# CCM only reconciles Oracle nodes in this mixed cluster. node-filter.patch is that PR's diff without docs;
# drop this app once a release includes it.
# The Makefile defaults ARCH to amd64, so cross-compile per TARGETARCH rather than build under QEMU
FROM --platform=$BUILDPLATFORM golang:1.26.6 AS builder
ARG TARGETARCH VERSION
WORKDIR /go/src/github.com/oracle/oci-cloud-controller-manager
COPY --from=src . .
COPY node-filter.patch /tmp/
RUN git apply /tmp/node-filter.patch && make build ARCH="$TARGETARCH" VERSION="$VERSION" BUILD="$VERSION"

FROM ghcr.io/oracle/oraclelinux:8-slim-fips
RUN microdnf -y install util-linux e2fsprogs xfsprogs python2 && \
    microdnf update && \
    microdnf clean all
COPY --from=src --chmod=755 scripts/encrypt-mount scripts/encrypt-umount scripts/rpm-host scripts/chroot-bash /sbin/
COPY --from=src image/ /usr/local/bin/
COPY --from=builder /go/src/github.com/oracle/oci-cloud-controller-manager/dist/ /usr/local/bin/

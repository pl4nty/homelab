# Upstream's Dockerfile plus these patches (diffs without docs); drop each once a release includes the fix:
# - node-filter.patch, oracle/oci-cloud-controller-manager#544 (--node-filter-requirements), so the CCM only
#   reconciles Oracle nodes in this mixed cluster
# - node-lookups.patch, ours: getNodeIpFamily and getCompartmentIDByInstanceID gave up on the first node
#   without an OCI provider ID, including the node being initialised, so nodes never got one (#522). They now
#   skip non-OCI nodes, find the uninitialised node by name, and read the compartment from the instance
# - no python2: Oracle Linux 9 has none, and only image/install.py (the legacy flexvolume installer, unused here) needs it
# The Makefile defaults ARCH to amd64, so cross-compile per TARGETARCH rather than build under QEMU
FROM --platform=$BUILDPLATFORM golang:1.27.3@sha256:e519d3b0a5b285e5aa53ab9eef02bc6bbb9cb04608389b743a136a9ce75f0d1e AS builder
ARG TARGETARCH VERSION
WORKDIR /go/src/github.com/oracle/oci-cloud-controller-manager
COPY --from=src . .
COPY *.patch /tmp/
RUN git apply /tmp/*.patch && make build ARCH="$TARGETARCH" VERSION="$VERSION" BUILD="$VERSION"

FROM ghcr.io/oracle/oraclelinux:9-slim-fips@sha256:edd4c909ec104e18d170acefe675ea73fda098426b098818d080e9977b92a360
RUN microdnf -y install util-linux e2fsprogs xfsprogs && \
    microdnf update && \
    microdnf clean all
COPY --from=src --chmod=755 scripts/encrypt-mount scripts/encrypt-umount scripts/rpm-host scripts/chroot-bash /sbin/
COPY --from=src image/ /usr/local/bin/
COPY --from=builder /go/src/github.com/oracle/oci-cloud-controller-manager/dist/ /usr/local/bin/

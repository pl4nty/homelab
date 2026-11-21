FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim@sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58
ARG TARGETARCH
# renovate: datasource=github-releases depName=openclaw/crabbox extractVersion=^v(?<version>.+)$
ARG CRABBOX_VERSION=0.83.0
# devbox and sprite have no release feed Renovate can read: bump the version and checksums together
ARG DEVBOX_VERSION=0.0.213
ARG DEVBOX_SHA256_amd64=7fba7260f2152f2e6830aff699ad3cb9eccb182cc6ace92fe4f2acea81456aaf
ARG DEVBOX_SHA256_arm64=6590ba8215bbd13d29f0e4efd6766f1428f6549fbce2761a7839b4d3703577f6
ARG SPRITE_VERSION=2026-11-03
ARG SPRITE_SHA256_amd64=731af477ecf7328fd188c67b3649874c9107b6f0097c25888d0dd17aad823527
ARG SPRITE_SHA256_arm64=c82c83bfed28e4b67c2c6bf63b0aecb9addc4c568eccb6aef399f21bfcc6d486
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client rsync \
 && rm -rf /var/lib/apt/lists/* \
 && cd /tmp \
 && curl -fsSLO "https://github.com/openclaw/crabbox/releases/download/v${CRABBOX_VERSION}/crabbox_${CRABBOX_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && curl -fsSLO "https://github.com/openclaw/crabbox/releases/download/v${CRABBOX_VERSION}/checksums.txt" \
 && sha256sum -c --ignore-missing checksums.txt \
 && mkdir /opt/crabbox \
 && tar -xzf "crabbox_${CRABBOX_VERSION}_linux_${TARGETARCH}.tar.gz" -C /opt/crabbox \
 && eval devbox_sha="\$DEVBOX_SHA256_${TARGETARCH}" sprite_sha="\$SPRITE_SHA256_${TARGETARCH}" \
 && curl -fsSLo devbox.tar.gz "https://get.namespace.so/packages/devbox/v${DEVBOX_VERSION}/devbox_${DEVBOX_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && echo "$devbox_sha  devbox.tar.gz" | sha256sum -c \
 && tar -xzf devbox.tar.gz -C /usr/local/bin devbox \
 && sprite_arch=$(echo "$TARGETARCH" | sed 's/amd64/x86_64/; s/arm64/aarch64/') \
 && curl -fsSLo /usr/local/bin/sprite "https://sprites.dev/dl/client/${SPRITE_VERSION}/sprite-linux-${sprite_arch}" \
 && echo "$sprite_sha  /usr/local/bin/sprite" | sha256sum -c \
 && chmod +x /usr/local/bin/sprite \
 && rm -rf /tmp/*
ENV UV_LINK_MODE=copy
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=uv,target=/root/.cache/uv \
    uv sync --frozen --no-editable \
 && useradd -u 1000 -m mcp
USER 1000
ENV PATH=/app/.venv/bin:/opt/crabbox:$PATH PYTHONUNBUFFERED=1 HOME=/data/home
EXPOSE 8000
CMD ["crabbox-mcp"]

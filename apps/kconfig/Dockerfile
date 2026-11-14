FROM --platform=$BUILDPLATFORM ghcr.io/astral-sh/uv:python3.14-trixie-slim@sha256:e80c05a310400cfc90af00b5b7271ef9ad24816e3265e1162af8a678e1aad099 AS index
RUN --mount=type=cache,id=apt-cache-trixie,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-trixie,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git patch gcc gcc-aarch64-linux-gnu gcc-riscv64-linux-gnu
WORKDIR /index
COPY index/pyproject.toml index/uv.lock index/kconfiglib.patch ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked && \
    patch "$(.venv/bin/python -c 'import kconfiglib; print(kconfiglib.__file__)')" kconfiglib.patch
COPY index/index.py .
ARG TREES
RUN .venv/bin/python index.py "$TREES" /work /out /ref && rm -rf /work

FROM --platform=$BUILDPLATFORM node:26.12.1@sha256:97fa0f1b59035c6072721a88d55be1371c7cb1cc942b521e1cc5c72ec87655f4 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci
COPY web .
COPY --from=index /out public/data
COPY --from=index /out/trees.json src/trees.json
RUN --mount=type=bind,from=index,source=/ref,target=/ref \
    KCONFIG_REF=/ref npm test && npm run build

FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a
COPY --from=web /web/dist /public
COPY sws.toml /sws.toml
ENV SERVER_PORT=8080 SERVER_SECURITY_HEADERS=true SERVER_CONFIG_FILE=/sws.toml
EXPOSE 8080

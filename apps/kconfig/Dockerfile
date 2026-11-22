FROM --platform=$BUILDPLATFORM ghcr.io/astral-sh/uv:python3.14-trixie-slim@sha256:e80c05a310400cfc90af00b5b7271ef9ad24816e3265e1162af8a678e1aad099 AS index
RUN --mount=type=cache,id=apt-cache-trixie,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-trixie,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git patch gcc gcc-aarch64-linux-gnu gcc-riscv64-linux-gnu
WORKDIR /app
COPY pyproject.toml uv.lock kconfiglib.patch ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked && \
    patch .venv/lib/python3.14/site-packages/kconfiglib.py kconfiglib.patch
COPY build.py .
ARG TREES
RUN .venv/bin/python build.py "$TREES" /work /data && rm -rf /work

FROM ghcr.io/astral-sh/uv:python3.14-trixie-slim@sha256:e80c05a310400cfc90af00b5b7271ef9ad24816e3265e1162af8a678e1aad099
ENV UV_LINK_MODE=copy
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-package kconfiglib --no-install-package kernel-hardening-checker
COPY --from=index /app/.venv/lib/python3.14/site-packages/kconfiglib.py .venv/lib/python3.14/site-packages/
COPY --from=index /app/.venv/lib/python3.14/site-packages/kernel_hardening_checker .venv/lib/python3.14/site-packages/kernel_hardening_checker
COPY --from=index /data /data
COPY app.py style.css ./
USER 1000
ENV PYTHONUNBUFFERED=1 NICEGUI_STORAGE_PATH=/tmp/nicegui
EXPOSE 8080
CMD [".venv/bin/python", "app.py"]

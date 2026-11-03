FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim@sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58
ENV UV_LINK_MODE=copy
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-editable \
 && useradd -u 1000 -m mcp
USER 1000
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["mcp-server"]

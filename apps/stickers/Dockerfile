FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --extra dev \
 && uv run --frozen pytest --ignore tests/test_ui.py \
 && uv sync --frozen --no-editable

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim
WORKDIR /app
COPY --from=build /app/.venv .venv
RUN useradd -u 1000 -m stickers && mkdir /data && chown stickers /data
USER 1000
ENV PATH=/app/.venv/bin:$PATH STICKERS_DATA=/data PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["stickers"]

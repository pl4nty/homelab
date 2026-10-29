FROM --platform=$BUILDPLATFORM ghcr.io/astral-sh/uv:python3.13-bookworm-slim@sha256:531f855bda2c73cd6ef67d56b733b357cea384185b3022bd09f05e002cd144ca AS test
ENV UV_PROJECT_ENVIRONMENT=/venv
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv run --frozen --extra dev pytest --ignore tests/test_ui.py

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim@sha256:531f855bda2c73cd6ef67d56b733b357cea384185b3022bd09f05e002cd144ca
ENV UV_LINK_MODE=copy
WORKDIR /app
COPY --from=test /app .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-editable \
 && useradd -u 1000 -m stickers && mkdir /data && chown stickers /data
USER 1000
ENV PATH=/app/.venv/bin:$PATH STICKERS_DATA=/data PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["stickers"]

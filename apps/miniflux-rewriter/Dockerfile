FROM python:3.14-slim@sha256:ce40764625a4ff50df3548277632e7f96c4e77fe75fa848aae9885476e7df5a4
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 PATH=/app/.venv/bin:$PATH
WORKDIR /app

RUN --mount=type=cache,id=uv,target=/root/.cache/uv \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    uv sync --locked --no-install-project

COPY app.py .

CMD ["python", "app.py"]

EXPOSE 8080

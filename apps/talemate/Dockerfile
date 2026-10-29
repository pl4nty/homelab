# Upstream's Dockerfile at the pinned src commit, changed so it builds for arm64 too:
# - the frontend builds once on the native platform, and the runtime takes node from its own stage
# - FFmpeg comes from the BtbN build for the target architecture, not always linux64
# - LD_LIBRARY_PATH and PYTHONPATH are set outright instead of appending to unset variables
# - uv and pnpm downloads use cache mounts

# The backend-build stage creates the virtual environment and the final stage
# runs it, so both must install the same uv.
ARG UV_VERSION=0.12.5

# Stage 1: Frontend build (static assets, so build once on the native platform)
FROM --platform=$BUILDPLATFORM node:26.12.0@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e AS frontend-build

WORKDIR /app

# Enable pnpm via corepack (version pinned by package.json "packageManager").
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm asks before it purges a modules directory, and aborts when no TTY can
# answer. https://pnpm.io/settings#confirmmodulespurge
ENV CI=true
ARG COREPACK_VERSION=0.35.0
RUN npm install -g corepack@${COREPACK_VERSION} && corepack enable

COPY --from=src talemate_frontend/package.json talemate_frontend/pnpm-lock.yaml talemate_frontend/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

COPY --from=src talemate_frontend/ ./
RUN pnpm build

# Node.js runtime for the pi coding agent, for the target platform
FROM node:26.12.0@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e AS node

# Stage 2: Backend build
FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93 AS backend-build

WORKDIR /app

RUN apt-get update && apt-get install -y \
    bash \
    gcc \
    && rm -rf /var/lib/apt/lists/*

ARG UV_VERSION
RUN pip install uv==${UV_VERSION}

COPY --from=src pyproject.toml uv.lock /app/
# the source is needed for the editable install
COPY --from=src src /app/src

# torch and torchaudio come from the cu128 index, which has aarch64 wheels as well
ENV UV_LINK_MODE=copy
RUN --mount=type=cache,id=uv,target=/root/.cache/uv uv sync --frozen

# The help agent reads the bundled documentation from TALEMATE_ROOT/docs, and it
# reads nothing but markdown.
COPY --from=src docs /app/docs
RUN find /app/docs -type f ! -name "*.md" -delete && \
    find /app/docs -depth -type d -empty -delete

# Stage 3: Final image
FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93

WORKDIR /app

RUN apt-get update && apt-get install -y \
    bash \
    wget \
    tar \
    xz-utils \
    gettext-base \
    libstdc++6 \
    libatomic1 \
    && rm -rf /var/lib/apt/lists/*

ARG UV_VERSION
RUN pip install uv==${UV_VERSION}

# node 26 links libatomic, which python-slim doesn't ship
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

ARG PI_VERSION=0.80.10
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION} && \
    npm cache clean --force && \
    pi --version

ENV PI_CODING_AGENT_DIR=/app/pi
RUN mkdir -p /app/pi

COPY --from=backend-build /app/.venv /app/.venv

# FFmpeg shared libraries for torchcodec, which loads FFmpeg 4 to 8 only.
# BtbN names its builds linux64 and linuxarm64.
ARG TARGETARCH
ARG FFMPEG_VERSION=n8.1-latest
ARG FFMPEG_BRANCH=8.1
RUN case "$TARGETARCH" in amd64) arch=linux64 ;; arm64) arch=linuxarm64 ;; *) exit 1 ;; esac && \
    build=ffmpeg-${FFMPEG_VERSION}-${arch}-gpl-shared-${FFMPEG_BRANCH} && \
    cd /tmp && \
    wget -q https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${build}.tar.xz -O ffmpeg.tar.xz && \
    tar -xf ffmpeg.tar.xz && \
    cp -a ${build}/bin/* /app/.venv/bin/ && \
    cp -a ${build}/lib/* /app/.venv/lib/ && \
    rm -rf ${build} ffmpeg.tar.xz && \
    LD_LIBRARY_PATH=/app/.venv/lib /app/.venv/bin/ffmpeg -version | head -n 1

# so torchcodec can find the ffmpeg libraries at runtime
ENV LD_LIBRARY_PATH=/app/.venv/lib

# Fail the build, instead of scene loading at runtime, when the two no longer match.
RUN /app/.venv/bin/python -B -c "import torchcodec.decoders"

COPY --from=backend-build /app/src /app/src
COPY --from=backend-build /app/docs /app/docs

COPY --from=frontend-build /app/dist /app/talemate_frontend/dist
# kept as the template for runtime envsubst substitution
COPY --from=frontend-build /app/dist/index.html /app/talemate_frontend/dist/index.template.html

COPY --from=src frontend_wsgi.py /app/frontend_wsgi.py
COPY --from=src config.example.yaml /app/config.yaml
COPY --from=src scenes/ /app/scenes/
COPY --from=src templates/ /app/templates/
COPY --from=src chroma* /app/
COPY --from=src tts/ /app/tts/

COPY --from=src --chmod=755 docker-entrypoint.sh /app/docker-entrypoint.sh

ENV PYTHONPATH=/app/src

# Bind on all interfaces inside the container by default. Ports can be
# overridden with TALEMATE_BACKEND_PORT / TALEMATE_FRONTEND_PORT.
ENV TALEMATE_BACKEND_HOST=0.0.0.0
ENV TALEMATE_FRONTEND_HOST=0.0.0.0

EXPOSE 5050
EXPOSE 8082

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["uv", "run", "src/talemate/server/run.py", "runserver"]

FROM --platform=$BUILDPLATFORM node:22.19.0@sha256:afff6d8c97964a438d2e6a9c96509367e45d8bf93f790ad561a1eaea926303d9 AS build
WORKDIR /app

# puppeteer dependency can't install ARM chromium by default
# puppeteer/puppeteer#7740
# keep downloaded debs so the apt cache mount is worth having
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
  && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,id=apt-cache-node22,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-node22,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=src package*.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm npm ci

COPY --from=src . .
RUN npm run build --if-present

FROM joseluisq/static-web-server:2.38.0@sha256:acfb7d76452f9746c5d2f8d791c9b659ac277b2b63fcac3ad97276fcdc969ffc

COPY --from=build /app/Pages /public/Pages
COPY --from=build /app/Pages/mha.html /public/index.html

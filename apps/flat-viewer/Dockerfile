# vite 2 loads postcss through the "./": "./" exports mapping node dropped in 17:
# Package subpath './lib/node' is not defined by "exports"
FROM --platform=$BUILDPLATFORM node:16.20.2@sha256:f77a1aef2da8d83e45ec990f45df50f1a286c5fe8bbfb8c6e4246c6389705c0b AS build
WORKDIR /app

COPY --from=src package.json yarn.lock ./
RUN --mount=type=cache,id=yarn,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile --network-timeout 600000

COPY --from=src . .
RUN yarn build

FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a

COPY --from=build /app/dist /public

# /:owner/:name is client-side routing, not files on disk
ENV SERVER_FALLBACK_PAGE=/public/index.html
ENV SERVER_PORT=8080
EXPOSE 8080

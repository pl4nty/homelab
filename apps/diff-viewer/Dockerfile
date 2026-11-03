FROM --platform=$BUILDPLATFORM node:22.23.4@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd AS build
WORKDIR /app

COPY --from=src package.json package-lock.json ./
# husky's prepare hook needs .git, which the git context drops
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci --ignore-scripts

COPY --from=src . .
# nuxt 2 bundles with webpack 4, which needs MD4
ENV NODE_OPTIONS=--openssl-legacy-provider
RUN npm run generate

FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a

COPY --from=build /app/dist /public

ENV SERVER_FALLBACK_PAGE=/public/index.html
ENV SERVER_PORT=8080
EXPOSE 8080

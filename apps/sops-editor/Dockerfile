FROM --platform=$BUILDPLATFORM ghcr.io/getsops/sops:v3.13.3-alpine@sha256:ae501277bf742f1662e0f881f43dd8fd6798b489a8058e921dbf6cda597140ea AS sops

FROM --platform=$BUILDPLATFORM node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS build
WORKDIR /src
COPY --from=sops /usr/local/bin/sops /usr/local/bin/sops
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm test && npm run build

FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a
COPY --from=build /src/dist /public
COPY sws.toml /sws.toml
ENV SERVER_PORT=8080 SERVER_SECURITY_HEADERS=true SERVER_CONFIG_FILE=/sws.toml
EXPOSE 8080

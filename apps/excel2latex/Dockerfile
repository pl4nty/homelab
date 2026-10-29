FROM --platform=$BUILDPLATFORM node:26.12.0@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e AS build
WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm npm ci

COPY . .
RUN npm run build

FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a

COPY --from=build /app/dist /public

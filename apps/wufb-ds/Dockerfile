FROM --platform=$BUILDPLATFORM node:24.22.0@sha256:925de64a85319052d6971ae81ef2417da956e8a3a2c4a0fac732327970f017f5 AS build-env
WORKDIR /app

COPY --from=src package.json ./
COPY package-lock.json ./
# lock wasn't updated so npm ci fails
RUN --mount=type=cache,id=npm,target=/root/.npm npm install

COPY --from=src . .
COPY package-lock.json ./
COPY src src
RUN npm run build

FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a

COPY --from=build-env /app/dist /public

ENV SERVER_PORT=8080
EXPOSE 8080

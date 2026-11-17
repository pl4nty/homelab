FROM --platform=$BUILDPLATFORM node:26.13.0@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725 AS build-env
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

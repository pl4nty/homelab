FROM --platform=$BUILDPLATFORM node:26.13.1@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac AS build-env
WORKDIR /app

COPY --from=src package.json ./
COPY package-lock.json ./
# lock wasn't updated so npm ci fails
RUN --mount=type=cache,id=npm,target=/root/.npm npm install

COPY --from=src . .
COPY package-lock.json ./
COPY src src
RUN npm run build

FROM joseluisq/static-web-server:2.44.2@sha256:23be6c04d474979d6e738081918f5874f88502a150d1123fd000719101a0f05c

COPY --from=build-env /app/dist /public

ENV SERVER_PORT=8080
EXPOSE 8080

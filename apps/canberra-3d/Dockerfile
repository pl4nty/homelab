FROM --platform=$BUILDPLATFORM node:26.13.1@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci
COPY . .
RUN npm test && npm run build

# the server is one bundled file with no native modules, so the build stage's output runs on any platform
FROM node:26.13.1-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5
COPY --from=build /app/dist/server.mjs /app/server.mjs
COPY --from=build /app/dist/web /web
ENV NODE_ENV=production
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.mjs"]

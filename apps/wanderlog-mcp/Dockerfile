# https://github.com/shaikhspeare/wanderlog-mcp, stdio entrypoint for ToolHive (upstream's image runs the HTTP server)
# Pure JS, so build, test and prune once on the build platform rather than under QEMU
FROM --platform=$BUILDPLATFORM node:26.12.1-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS build
WORKDIR /app
COPY --from=src package.json package-lock.json ./
RUN npm ci
COPY --from=src tsconfig.json vitest.config.ts ./
COPY --from=src src/ src/
COPY --from=src tests/ tests/
RUN npm run build && npm test && npm prune --omit=dev

FROM node:26.12.1-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
USER node
ENTRYPOINT ["node", "/app/dist/index.js"]

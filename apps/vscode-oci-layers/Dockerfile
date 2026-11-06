FROM --platform=$BUILDPLATFORM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run typecheck && npm test && npm run build

FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS proxy-deps
WORKDIR /app/proxy
COPY proxy/package.json proxy/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production --frozen-lockfile

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
WORKDIR /app
COPY proxy/ proxy/
COPY --from=proxy-deps /app/proxy/node_modules/ proxy/node_modules/
COPY --from=build /src/package.json /src/README.md /src/scm-diff.png /src/pushed.png public/
COPY --from=build /src/dist/web/ public/dist/web/
ENV HOST=0.0.0.0 PUBLIC_DIR=/app/public
USER 65532
EXPOSE 8080
CMD ["proxy/serve.mjs", "8080"]

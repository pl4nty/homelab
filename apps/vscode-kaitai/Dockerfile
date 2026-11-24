FROM --platform=$BUILDPLATFORM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run typecheck && npm test && npm run build

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
WORKDIR /app
COPY server/ server/
COPY --from=build /src/package.json /src/README.md /src/language-configuration.json public/
COPY --from=build /src/syntaxes/ public/syntaxes/
COPY --from=build /src/dist/web/ public/dist/web/
COPY --from=build /src/dist/webview/ public/dist/webview/
COPY --from=build /src/media/ public/media/
ENV HOST=0.0.0.0 PUBLIC_DIR=/app/public
USER 65532
EXPOSE 8080
CMD ["server/serve.mjs", "8080"]

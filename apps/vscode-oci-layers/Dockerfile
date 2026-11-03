FROM --platform=$BUILDPLATFORM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run typecheck && npm test && npm run build

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
WORKDIR /app
COPY proxy/ proxy/
COPY --from=build /src/package.json /src/README.md /src/scm-diff.png /src/pushed.png public/
COPY --from=build /src/dist/web/ public/dist/web/
ENV HOST=0.0.0.0 PUBLIC_DIR=/app/public
USER 65532
EXPOSE 8080
CMD ["proxy/serve.mjs", "8080"]

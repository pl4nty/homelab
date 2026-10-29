FROM --platform=$BUILDPLATFORM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS build
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

FROM --platform=$BUILDPLATFORM node:26.12.0@sha256:45a2bf9d9300e9cf47ecb375e38447c140c45ef5fbae869c430475b05b98d86e AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci
COPY web .
RUN npm test && npm run build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS server
WORKDIR /src
COPY go.mod *.go ./
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,id=go-build,target=/root/.cache/go-build \
    go test ./... && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags=-s -o /diff-viewer .

FROM scratch
COPY --from=server /diff-viewer /diff-viewer
COPY --from=web /web/dist /web
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/diff-viewer"]

FROM --platform=$BUILDPLATFORM node:26.13.1@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci
COPY web .
RUN npm test && npm run build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS server
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

FROM --platform=$BUILDPLATFORM node:26.12.1@sha256:97fa0f1b59035c6072721a88d55be1371c7cb1cc942b521e1cc5c72ec87655f4 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci
COPY web .
RUN npm test && npm run build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS server
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

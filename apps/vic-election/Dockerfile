FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS server
WORKDIR /src
COPY go.mod *.go ./
COPY web web
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,id=go-build,target=/root/.cache/go-build \
    go test ./... && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags=-s -o /vic-election .

FROM scratch
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=server /vic-election /vic-election
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/vic-election"]

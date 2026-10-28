FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS builder
WORKDIR /build
COPY --from=src . .
RUN apk add --update git gcc
ARG TARGETOS TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH CGO_ENABLED=0 \
  go install -gcflags "-N -l" ./cmd/flares

FROM alpine:latest@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
RUN apk add --update --no-cache \
  ca-certificates && \
  update-ca-certificates
COPY --from=builder /go/bin/ /usr/local/bin/
WORKDIR /usr/local/bin/
ENTRYPOINT ["flares"]

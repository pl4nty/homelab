FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS builder
WORKDIR /build
COPY --from=src . .
RUN apk add --update git gcc
ARG TARGETOS TARGETARCH
# go install puts cross-compiled binaries in /go/bin/<os>_<arch>/, which isn't on PATH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH CGO_ENABLED=0 \
  go build -gcflags "-N -l" -o /out/flares ./cmd/flares

FROM alpine:latest@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --update --no-cache \
  ca-certificates && \
  update-ca-certificates
COPY --from=builder /out/flares /usr/local/bin/flares
WORKDIR /usr/local/bin/
ENTRYPOINT ["flares"]

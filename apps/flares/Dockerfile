FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS builder
WORKDIR /build
COPY --from=src . .
RUN apk add --update git gcc
ARG TARGETOS TARGETARCH
# go install puts cross-compiled binaries in /go/bin/<os>_<arch>/, which isn't on PATH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH CGO_ENABLED=0 \
  go build -gcflags "-N -l" -o /out/flares ./cmd/flares

FROM alpine:latest@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --update --no-cache \
  ca-certificates && \
  update-ca-certificates
COPY --from=builder /out/flares /usr/local/bin/flares
WORKDIR /usr/local/bin/
ENTRYPOINT ["flares"]

FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.10.0@sha256:40fe21f44bb8cddf1eb1226db190d0a984118f62ee02a91b77d99448d28264a6 AS xx

# ipatool's keyring dependency needs cgo on linux
FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS builder
COPY --from=xx / /
RUN apk add --no-cache clang lld gcc musl-dev
ARG TARGETPLATFORM
RUN xx-apk add --no-cache gcc musl-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# otelc (a go.mod tool) adds OpenTelemetry for gin, net/http and slog at compile time. build it for the
# build platform first, then wrap go so otelc's own go invocations cross-compile the app
RUN CGO_ENABLED=1 go test ./... && go build -o /usr/local/bin/otelc go.opentelemetry.io/otelc/tool/cmd/otelc \
  && xx-go --wrap && CGO_ENABLED=1 otelc go build -o /ipa-web . && xx-verify /ipa-web

FROM alpine:latest@sha256:3f4d6b32e26703c6082839234f43769d5046b3ac7c910033911d1e71d8cd630a
RUN apk add --no-cache ca-certificates
COPY --from=builder /ipa-web /usr/local/bin/ipa-web
ENTRYPOINT ["ipa-web"]

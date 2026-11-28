FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.10.0@sha256:40fe21f44bb8cddf1eb1226db190d0a984118f62ee02a91b77d99448d28264a6 AS xx

# ipatool's keyring dependency needs cgo on linux
FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS builder
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

FROM alpine:latest@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache ca-certificates
COPY --from=builder /ipa-web /usr/local/bin/ipa-web
ENTRYPOINT ["ipa-web"]

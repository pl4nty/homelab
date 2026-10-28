FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.7.0@sha256:010d4b66aed389848b0694f91c7aaee9df59a6f20be7f5d12e53663a37bd14e2 AS xx

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
RUN CGO_ENABLED=1 go test ./... && CGO_ENABLED=1 xx-go build -o /ipa-web . && xx-verify /ipa-web

FROM alpine:latest@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
RUN apk add --no-cache ca-certificates
COPY --from=builder /ipa-web /usr/local/bin/ipa-web
ENTRYPOINT ["ipa-web"]

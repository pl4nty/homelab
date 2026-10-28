FROM golang:1.21.4 AS build

WORKDIR /app
COPY go.* ./
RUN go mod download

COPY . ./
RUN CGO_ENABLED=0 make

FROM scratch
COPY --from=build /app/ct_monitor ./
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ENTRYPOINT [ "/ct_monitor" ]

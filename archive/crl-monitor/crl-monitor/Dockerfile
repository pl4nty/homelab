FROM golang:1.21.4 AS build

WORKDIR /app
COPY go.* ./
RUN go mod download

COPY *.go ./
# can't use Makefile, it references SVN
RUN CGO_ENABLED=0 go build -ldflags "-X main.build_date=`date -u +%Y-%m-%d.%H:%M:%S`" crl_monitor.go processor_main.go

FROM scratch
COPY --from=build /app/crl_monitor ./
ENTRYPOINT [ "/crl_monitor" ]

FROM golang:1.21.5 AS build

WORKDIR /app
COPY go.* ./
RUN go mod download

COPY *.go ./
# can't use Makefile, it references SVN
RUN CGO_ENABLED=0 go build -ldflags "-X main.build_date=`date -u +%Y-%m-%d.%H:%M:%S`" caissuer_monitor.go processor_main.go

FROM scratch
COPY --from=build /app/caissuer_monitor ./
ENTRYPOINT [ "/caissuer_monitor" ]

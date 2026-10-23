# syntax=docker/dockerfile:1.7
# Runner pembangkit beban: biner Go (diuji saat build) + k6 resmi. Konteks build = akar repo.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY loadgen/go.mod ./
COPY loadgen/*.go ./
RUN go vet ./... && go test -count=1 ./... \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/aiops-loadgen .

FROM grafana/k6:0.54.0 AS k6

FROM alpine:3.20
LABEL org.opencontainers.image.title="aiops-loadgen" org.opencontainers.image.description="Runner pembangkit beban untuk AI Ops (k6)"
RUN apk add --no-cache ca-certificates tini && adduser -S -u 10002 loadgen
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
COPY --from=build /out/aiops-loadgen /usr/local/bin/aiops-loadgen
USER loadgen
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/aiops-loadgen"]

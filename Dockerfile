# syntax=docker/dockerfile:1.7
# Konteks build = akar repo: server/ (Express + TypeScript), web/ (React + Vite), agent/ (Go), simulator/ (analyzer untuk rencana setup).

FROM node:24-alpine AS base
WORKDIR /build/server

FROM base AS deps
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS build
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build

FROM base AS prod-deps
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# UI React: dites dan dibangun statis; hasilnya disajikan oleh server
FROM node:24-alpine AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/src ./src
COPY web/public ./public
RUN npm test && npm run build

# agen Go: diuji saat build, lalu dikompilasi statis untuk linux amd64 dan arm64
FROM golang:1.24-alpine AS agent
WORKDIR /src
COPY agent/go.mod ./
COPY agent/*.go ./
ARG AGENT_VERSION=1.0.0
RUN go vet ./... && go test -count=1 ./... \
 && for a in amd64 arm64; do CGO_ENABLED=0 GOOS=linux GOARCH=$a go build -trimpath -ldflags "-s -w -X main.version=${AGENT_VERSION}" -o /out/aiops-agent-linux-$a . ; done \
 && cd /out && sha256sum aiops-agent-linux-* > SHA256SUMS

FROM node:24-alpine AS runtime
LABEL org.opencontainers.image.title="aiops-server" org.opencontainers.image.description="AI Ops: setup server oleh agen, monitoring, notifikasi"
# openssh-client: eksekusi perintah di server; tini: PID 1 yang membersihkan proses ssh yatim dan meneruskan sinyal
RUN apk add --no-cache openssh-client tini \
 && addgroup -S -g 10001 aiops && adduser -S -u 10001 -G aiops -h /home/aiops aiops \
 && mkdir -p /data /app && chown -R aiops:aiops /data /home/aiops
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 DATA_DIR=/data LEGACY_ROOT=/app/legacy
WORKDIR /app
COPY --from=prod-deps /build/server/node_modules ./node_modules
COPY --from=build /build/server/dist ./dist
COPY server/package.json ./package.json
COPY server/migrations ./migrations
COPY --from=web /build/web/dist ./public
COPY --from=agent /out ./agent-bin
# simulator (CommonJS, tanpa dependensi): analyzer proyek, mesin simulasi, komponen eksperimen, dan worker lab (halaman Arsitektur + rencana dari folder proyek)
COPY simulator/src/patch.js simulator/src/engine.js simulator/src/recommend.js simulator/src/bench.js simulator/src/load.js simulator/src/components.js simulator/src/lab.js simulator/src/sensitivity.js simulator/src/failures.js simulator/src/rng.js ./legacy/src/
COPY simulator/tools/analyze.js simulator/tools/benchmark.js simulator/tools/pipeline.js simulator/tools/lab-worker.js ./legacy/tools/
COPY simulator/tools/analyze ./legacy/tools/analyze
COPY simulator/architectures ./legacy/architectures
RUN echo '{"type":"commonjs"}' > ./legacy/package.json
USER aiops
EXPOSE 4317
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

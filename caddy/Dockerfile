# Caddy dengan plugin DNS (untuk sertifikat Let's Encrypt via DNS-01 pada IP privat). Ganti penyedia: --build-arg DNS_PROVIDER=route53 dst.
# Daftar penyedia: https://github.com/caddy-dns
ARG DNS_PROVIDER=cloudflare
FROM caddy:2-builder AS build
ARG DNS_PROVIDER
RUN xcaddy build --with github.com/caddy-dns/${DNS_PROVIDER}

FROM caddy:2-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy

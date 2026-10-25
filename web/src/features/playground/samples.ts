// Contoh Compose untuk mengisi formulir. Sengaja kecil dan memakai image publik bertanda versi.
export interface Sample { id: string; label: string; description: string; parts: string[]; compose: string; health: string }

export const SAMPLES: Sample[] = [
  {
    id: 'web-redis', label: 'Web sederhana + Redis',
    description: 'Satu web server dengan cache Redis. Pilihan paling aman untuk mencoba Playground pertama kali.',
    parts: ['nginx', 'redis'],
    health: '/',
    compose: `services:
  web:
    image: nginx:1.27-alpine
    ports: ["8080:80"]
    depends_on: [cache]
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/"]
      interval: 5s
      retries: 10
  cache:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10
`
  },
  {
    id: 'lb', label: 'Dua web di belakang load balancer',
    description: 'Dua web server dengan HAProxy di depannya. Untuk melihat bagaimana beban dibagi dan apa yang terjadi bila satu web mati.',
    parts: ['nginx', 'nginx', 'haproxy'],
    health: '/',
    compose: `services:
  web1:
    image: nginx:1.27-alpine
    healthcheck: { test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/"], interval: 5s, retries: 10 }
  web2:
    image: nginx:1.27-alpine
    healthcheck: { test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/"], interval: 5s, retries: 10 }
  lb:
    image: haproxy:3.0-alpine
    ports: ["8080:80"]
    depends_on: [web1, web2]
    configs:
      - source: haproxy
        target: /usr/local/etc/haproxy/haproxy.cfg
configs:
  haproxy:
    content: |
      defaults
        mode http
        timeout connect 3s
        timeout client 30s
        timeout server 30s
      frontend in
        bind *:80
        default_backend web
      backend web
        balance roundrobin
        server w1 web1:80 check
        server w2 web2:80 check
`
  }
];

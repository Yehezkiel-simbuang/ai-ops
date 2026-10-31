// Merakit docker-compose.yml dari komponen (aplikasi, database, Redis, load balancer, batas sumber daya) agar pengguna tidak menulis YAML.
// Hasilnya tetap dilewatkan ke analisis keamanan yang sama (compose.ts) sebelum dipasang.
import { stringify } from 'yaml';
import { z } from 'zod';

const image = z.string().trim().min(1).max(200).regex(/^[\w][\w./:@-]*$/, 'Nama image tidak valid');
const limits = z.object({ cpus: z.number().min(0.1).max(64).optional(), memory: z.string().regex(/^\d+(\.\d+)?[mg]$/i, 'Format memori mis. 512m atau 1g').optional() });

export const specSchema = z.object({
  app: z.object({
    image, port: z.number().int().min(1).max(65535).default(80), replicas: z.number().int().min(1).max(4).default(1),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(300)).default({}), limits: limits.default({}), healthPath: z.string().regex(/^(\/\S*)?$/).default('')
  }),
  db: z.object({ kind: z.enum(['postgres', 'mysql']), version: z.string().regex(/^[\w.-]{1,20}$/).default(''), limits: limits.default({}) }).nullable().default(null),
  redis: z.object({ limits: limits.default({}) }).nullable().default(null),
  lb: z.enum(['nginx', 'haproxy']).default('nginx'),
  publishPort: z.number().int().min(1024).max(65535).default(8080)
});
export type Spec = z.infer<typeof specSchema>;

const res = (l: { cpus?: number; memory?: string }) => (l.cpus || l.memory ? { deploy: { resources: { limits: { ...(l.cpus ? { cpus: String(l.cpus) } : {}), ...(l.memory ? { memory: l.memory.toLowerCase() } : {}) } } } } : {});
const hc = (test: string[]) => ({ healthcheck: { test, interval: '5s', timeout: '3s', retries: 12 } });

function nginxConf(n: number, port: number): string {
  const servers = Array.from({ length: n }, (_, i) => `    server app${i + 1}:${port};`).join('\n');
  return `upstream app {\n${servers}\n}\nserver {\n  listen 80;\n  location / { proxy_pass http://app; proxy_set_header Host $$host; }\n}\n`;
}
function haproxyConf(n: number, port: number): string {
  const servers = Array.from({ length: n }, (_, i) => `  server a${i + 1} app${i + 1}:${port} check`).join('\n');
  return `defaults\n  mode http\n  timeout connect 3s\n  timeout client 30s\n  timeout server 30s\nfrontend in\n  bind *:80\n  default_backend app\nbackend app\n  balance roundrobin\n${servers}\n`;
}

/** Nama layanan: app (1 replika) atau app1..appN di belakang lb. Hanya lb (atau app tunggal) yang mempublikasikan port. */
export function buildCompose(raw: unknown): string {
  const s = specSchema.parse(raw), services: Record<string, unknown> = {}, configs: Record<string, unknown> = {}, names: string[] = [];
  const env: Record<string, string> = { ...s.app.env };
  if (s.db?.kind === 'postgres') Object.assign(env, { DATABASE_URL: 'postgres://app:app@db:5432/app' });
  if (s.db?.kind === 'mysql') Object.assign(env, { DATABASE_URL: 'mysql://app:app@db:3306/app' });
  if (s.redis) env.REDIS_URL = 'redis://cache:6379';
  const deps = [s.db ? 'db' : '', s.redis ? 'cache' : ''].filter(Boolean);
  const appHealth = s.app.healthPath ? hc(['CMD-SHELL', `wget -q -O /dev/null http://127.0.0.1:${s.app.port}${s.app.healthPath} || exit 1`]) : {};
  const appBase = { image: s.app.image, ...(Object.keys(env).length ? { environment: env } : {}), ...(deps.length ? { depends_on: Object.fromEntries(deps.map((d) => [d, { condition: 'service_healthy' }])) } : {}), ...appHealth, ...res(s.app.limits) };
  if (s.app.replicas === 1) { services.app = { ...appBase, ports: [`${s.publishPort}:${s.app.port}`] }; names.push('app'); }
  else {
    for (let i = 1; i <= s.app.replicas; i++) { services[`app${i}`] = appBase; names.push(`app${i}`); }
    services.lb = s.lb === 'nginx'
      ? { image: 'nginx:1.27-alpine', ports: [`${s.publishPort}:80`], depends_on: names, configs: [{ source: 'lbconf', target: '/etc/nginx/conf.d/default.conf' }] }
      : { image: 'haproxy:3.0-alpine', ports: [`${s.publishPort}:80`], depends_on: names, configs: [{ source: 'lbconf', target: '/usr/local/etc/haproxy/haproxy.cfg' }] };
    configs.lbconf = { content: s.lb === 'nginx' ? nginxConf(s.app.replicas, s.app.port) : haproxyConf(s.app.replicas, s.app.port) };
  }
  if (s.db?.kind === 'postgres') services.db = { image: `postgres:${s.db.version || '17-alpine'}`, environment: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'app', POSTGRES_DB: 'app' }, ...hc(['CMD-SHELL', 'pg_isready -U app -d app']), ...res(s.db.limits) };
  if (s.db?.kind === 'mysql') services.db = { image: `mysql:${s.db.version || '8.4'}`, environment: { MYSQL_USER: 'app', MYSQL_PASSWORD: 'app', MYSQL_DATABASE: 'app', MYSQL_ROOT_PASSWORD: 'root' }, ...hc(['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1 -uroot -proot --silent']), ...res(s.db.limits) };
  if (s.redis) services.cache = { image: 'redis:7-alpine', ...hc(['CMD', 'redis-cli', 'ping']), ...res(s.redis.limits) };
  for (const k of Object.keys(services)) services[k] = { restart: 'unless-stopped', ...(services[k] as object) };   // kontainer menyala lagi setelah server di-restart
  return stringify({ services, ...(Object.keys(configs).length ? { configs } : {}) });
}

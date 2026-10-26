// Konfigurasi dari lingkungan, divalidasi saat start. Rahasia boleh lewat NAMA atau NAMA_FILE (Docker/Kubernetes secrets).
import { readFileSync } from 'node:fs';
import { z } from 'zod';

function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct) return direct;
  const file = env[name + '_FILE'];
  if (file) { try { return readFileSync(file, 'utf8').trim(); } catch { throw new Error(`${name}_FILE tidak bisa dibaca: ${file}`); } }
  return undefined;
}
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_POOL_MIN: z.coerce.number().int().min(0).max(50).default(0),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  DB_SSL: z.enum(['disable', 'require']).default('disable'),
  DB_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),

  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'MASTER_KEY harus 64 karakter heksadesimal (32 byte). Buat: openssl rand -hex 32'),
  MASTER_KEY_PREVIOUS: z.string().regex(/^[0-9a-fA-F]{64}(,[0-9a-fA-F]{64})*$/, 'MASTER_KEY_PREVIOUS berisi satu atau lebih kunci 64 heksadesimal, dipisah koma').optional(),   // kunci lama yang masih boleh membuka data sampai `rotate-key` dijalankan
  ADMIN_USERNAME: z.string().min(3).default('admin'),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD minimal 12 karakter').optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1'),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: bool.default(false),
  METRICS_TOKEN: z.string().min(16).optional(),
  LOADGEN_SECRET: z.string().min(24).optional(),             // rahasia bersama runner pembangkit beban; kosong = fitur uji beban dimatikan
  LOADTEST_ALLOWED_HOSTS: z.string().default(''),            // host non-privat yang boleh diuji (pisah koma; awalan titik = semua subdomain), mis. staging.contoh.com

  DATA_DIR: z.string().default('./data'),
  SSH_BIN: z.string().default('ssh'),
SSH_KEYGEN_BIN: z.string().default('ssh-keygen'),
  LEGACY_ROOT: z.string().default('../simulator'),   // folder modul simulator (analyzer, mesin, worker lab)
  PUBLIC_URL: z.string().url().optional(),        // URL yang dipakai agen untuk menghubungi aplikasi (untuk panduan pemasangan)
  AGENT_BIN_DIR: z.string().optional(),            // folder biner agen (bawaan: ./agent-bin di samping dist)
  PUBLIC_DIR: z.string().optional(),               // hasil build UI (bawaan: ./public di samping dist)
  PROJECTS_ROOT: z.string().optional(),   // folder proyek yang boleh dianalisis untuk rencana setup; kosong = fitur dimatikan
  RUN_SCHEDULER: bool.default(true)
});
export type Config = z.infer<typeof schema> & { cookieSecure: boolean; allowedHosts: string[]; masterKeyPrevious: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const merged: Record<string, string | undefined> = {
    ...env,
    DATABASE_URL: secret(env, 'DATABASE_URL'), MASTER_KEY: secret(env, 'MASTER_KEY'), MASTER_KEY_PREVIOUS: secret(env, 'MASTER_KEY_PREVIOUS'), ADMIN_PASSWORD: secret(env, 'ADMIN_PASSWORD'), METRICS_TOKEN: secret(env, 'METRICS_TOKEN'), LOADGEN_SECRET: secret(env, 'LOADGEN_SECRET')
  };
  for (const k of Object.keys(merged)) if (merged[k] === '') delete merged[k];   // variabel kosong (mis. dari compose) dianggap tidak diisi
  const r = schema.safeParse(merged);
  if (!r.success) throw new Error('Konfigurasi tidak valid:\n' + r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'));
  const c = r.data;
  return { ...c, cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production', allowedHosts: c.ALLOWED_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean), masterKeyPrevious: (c.MASTER_KEY_PREVIOUS ?? '').split(',').filter(Boolean) };
}

// Koneksi PostgreSQL: satu Pool bersama (node-postgres), transaksi, dan migrasi bernomor dengan kunci advisory.
// Pool: ukuran dibatasi (DB_POOL_MAX), koneksi menganggur dilepas, timeout koneksi dan statement, error pada koneksi idle tidak menjatuhkan proses.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { Config } from './config.js';

pg.types.setTypeParser(20, (v) => Number(v));      // bigint -> number (epoch ms dan id selalu < 2^53)
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric -> number

export type Row = Record<string, any>;
export interface Queryable { query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>; }
export interface Tx extends Queryable { one<T extends Row = Row>(text: string, params?: unknown[]): Promise<T | undefined>; exec(text: string, params?: unknown[]): Promise<number>; }

function wrap(c: { query: (text: string, params?: unknown[]) => Promise<pg.QueryResult> }): Tx {
  return {
    async query<T extends Row = Row>(text: string, params: unknown[] = []) { return (await c.query(text, params)).rows as T[]; },
    async one<T extends Row = Row>(text: string, params: unknown[] = []) { return ((await c.query(text, params)).rows[0] as T | undefined); },
    async exec(text: string, params: unknown[] = []) { return (await c.query(text, params)).rowCount ?? 0; }
  };
}

export class Db implements Tx {
  readonly pool: pg.Pool;
  private readonly w: Tx;
  constructor(cfg: Config, onError: (e: Error) => void = () => undefined) {
    const options = cfg.DB_SCHEMA ? `-c search_path=${cfg.DB_SCHEMA},public` : undefined;
    this.pool = new pg.Pool({
      connectionString: cfg.DATABASE_URL, max: cfg.DB_POOL_MAX, min: cfg.DB_POOL_MIN, idleTimeoutMillis: cfg.DB_IDLE_TIMEOUT_MS, connectionTimeoutMillis: cfg.DB_CONNECT_TIMEOUT_MS,
      statement_timeout: cfg.DB_STATEMENT_TIMEOUT_MS, query_timeout: cfg.DB_STATEMENT_TIMEOUT_MS + 2000, application_name: 'aiops-server', allowExitOnIdle: false,
      ssl: cfg.DB_SSL === 'require' ? { rejectUnauthorized: true } : undefined, options
    });
    this.pool.on('error', onError);   // koneksi idle yang putus: dicatat, pool membuat koneksi baru saat dibutuhkan
    this.w = wrap(this.pool);
  }
  query<T extends Row = Row>(text: string, params?: unknown[]) { return this.w.query<T>(text, params); }
  one<T extends Row = Row>(text: string, params?: unknown[]) { return this.w.one<T>(text, params); }
  exec(text: string, params?: unknown[]) { return this.w.exec(text, params); }
  async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const r = await fn(wrap(c)); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch { /* koneksi mungkin sudah putus */ } throw e; }
    finally { c.release(); }
  }
  async ping(): Promise<boolean> { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }
  stats() { return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount, max: (this.pool.options as { max?: number }).max ?? 0 }; }
  async close(): Promise<void> { await this.pool.end(); }
}

// ---------- migrasi: berkas migrations/NNN_nama.sql dijalankan berurutan, masing-masing dalam satu transaksi
const LOCK_KEY = 727_001;
export async function migrate(db: Db, dir: string, log: (m: string) => void = () => undefined, schema?: string): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort(), applied: string[] = [];
  const c = await db.pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    if (schema) await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at bigint NOT NULL)');
    const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version as string));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      try { await c.query('BEGIN'); await c.query(sql); await c.query('INSERT INTO schema_migrations(version, applied_at) VALUES($1,$2)', [f, Date.now()]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK'); throw new Error(`Migrasi ${f} gagal: ${(e as Error).message}`); }
      applied.push(f); log('migrasi diterapkan: ' + f);
    }
  } finally { try { await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch { /* abaikan */ } c.release(); }
  return applied;
}

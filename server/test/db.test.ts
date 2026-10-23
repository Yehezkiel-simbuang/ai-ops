// Basis data: pool, transaksi, migrasi (idempoten dan aman paralel), timeout statement, dan kunci pemimpin penjadwal.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Db, migrate } from '../src/db.js';
import { TEST_URL } from './helpers.js';

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');
const schema = 'd_' + randomBytes(5).toString('hex');
const mk = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_URL, DB_SCHEMA: schema, MASTER_KEY: 'a'.repeat(64), LOG_LEVEL: 'silent', ...env });
let db: Db;

beforeAll(async () => { db = new Db(mk()); });
afterAll(async () => { await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.close(); });

describe('migrasi', () => {
  it('menerapkan semua berkas sekali dan idempoten', async () => {
    const first = await migrate(db, MIGRATIONS, () => undefined, schema); expect(first.length).toBeGreaterThan(0);
    expect(await migrate(db, MIGRATIONS, () => undefined, schema)).toEqual([]);
    const t = await db.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]); const names = t.map((r) => r.tablename); for (const n of ['users', 'sessions', 'servers', 'runs', 'commands', 'checks', 'alerts', 'channels', 'schema_migrations']) expect(names).toContain(n);
  });
  it('migrasi paralel dari dua instance tidak bentrok (kunci advisory)', async () => {
    const s2 = 'd_' + randomBytes(5).toString('hex'), a = new Db(mk({ DB_SCHEMA: s2 })), b = new Db(mk({ DB_SCHEMA: s2 }));
    const [x, y] = await Promise.all([migrate(a, MIGRATIONS, () => undefined, s2), migrate(b, MIGRATIONS, () => undefined, s2)]);
    expect(x.length + y.length).toBe(x.length || y.length); expect(Math.min(x.length, y.length)).toBe(0);   // hanya satu yang menerapkan
    await a.exec(`DROP SCHEMA ${s2} CASCADE`); await a.close(); await b.close();
  });
  it('migrasi yang gagal di-rollback dan tidak tercatat', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mig-')); writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE ok_t(a int);'); writeFileSync(join(dir, '002_rusak.sql'), 'CREATE TABLE half_t(a int); SELECT * FROM tidak_ada;');
    const s3 = 'd_' + randomBytes(5).toString('hex'), d3 = new Db(mk({ DB_SCHEMA: s3 }));
    await expect(migrate(d3, dir, () => undefined, s3)).rejects.toThrow(/002_rusak/);
    expect((await d3.query('SELECT version FROM schema_migrations')).map((r) => r.version)).toEqual(['001_ok.sql']);
    expect(await d3.query("SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename='half_t'", [s3])).toHaveLength(0);
    await d3.exec(`DROP SCHEMA ${s3} CASCADE`); await d3.close();
  });
});

describe('transaksi', () => {
  it('commit menyimpan, error me-rollback seluruhnya', async () => {
    await db.tx(async (t) => { await t.exec('INSERT INTO meta(key,value) VALUES($1,$2)', ['a', '1']); });
    await expect(db.tx(async (t) => { await t.exec('INSERT INTO meta(key,value) VALUES($1,$2)', ['b', '2']); throw new Error('gagal'); })).rejects.toThrow('gagal');
    expect((await db.query('SELECT key FROM meta ORDER BY key')).map((r) => r.key)).toEqual(['a']);
  });
  it('koneksi dikembalikan ke pool walau transaksi gagal (tidak bocor)', async () => {
    for (let i = 0; i < 30; i++) await db.tx(async () => { throw new Error('x'); }).catch(() => undefined);
    const s = db.stats(); expect(s.total - s.idle).toBe(0);
  });
});

describe('pool', () => {
  it('antrean saat pool penuh: permintaan menunggu, tidak gagal, dan semuanya selesai', async () => {
    const small = new Db(mk({ DB_POOL_MAX: '2' }));
    const t0 = Date.now(); const rs = await Promise.all(Array.from({ length: 6 }, () => small.query('SELECT pg_sleep(0.15), 1 AS x')));
    expect(rs.every((r) => r[0]!.x === 1)).toBe(true); expect(Date.now() - t0).toBeGreaterThanOrEqual(400);   // 6 query x 0,15 dtk / 2 koneksi = sekitar 0,45 dtk
    expect(small.stats().max).toBe(2); expect(small.stats().total).toBeLessThanOrEqual(2); await small.close();
  });
  it('batas waktu koneksi: gagal cepat bila pool habis terlalu lama', async () => {
    const tiny = new Db(mk({ DB_POOL_MAX: '1', DB_CONNECT_TIMEOUT_MS: '500' })); const hold = tiny.query('SELECT pg_sleep(1.5)');
    await new Promise((r) => setTimeout(r, 50)); await expect(tiny.query('SELECT 1')).rejects.toThrow(/timeout/i); await hold; await tiny.close();
  });
  it('statement_timeout menghentikan query yang menggantung', async () => {
    const s = new Db(mk({ DB_STATEMENT_TIMEOUT_MS: '1000' })); const t0 = Date.now();
    await expect(s.query('SELECT pg_sleep(5)')).rejects.toThrow(); expect(Date.now() - t0).toBeLessThan(3500); expect(await s.ping()).toBe(true); await s.close();
  });
  it('ping false setelah pool ditutup', async () => { const s = new Db(mk()); await s.close(); expect(await s.ping()).toBe(false); });
});

describe('kunci pemimpin penjadwal', () => {
  it('hanya satu sesi yang memegang kunci advisory pada satu waktu', async () => {
    const a = new pg.Client({ connectionString: TEST_URL }), b = new pg.Client({ connectionString: TEST_URL }); await a.connect(); await b.connect();
    expect((await a.query('SELECT pg_try_advisory_lock(727002) AS ok')).rows[0].ok).toBe(true); expect((await b.query('SELECT pg_try_advisory_lock(727002) AS ok')).rows[0].ok).toBe(false);
    await a.end();   // sesi pemimpin putus: kunci dilepas otomatis
    await new Promise((r) => setTimeout(r, 100)); expect((await b.query('SELECT pg_try_advisory_lock(727002) AS ok')).rows[0].ok).toBe(true); await b.end();
  });
});

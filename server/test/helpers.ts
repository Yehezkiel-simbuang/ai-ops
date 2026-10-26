// Alat uji: konteks aplikasi dengan skema PostgreSQL terisolasi per berkas uji (tanpa port HTTP, lewat light-my-request).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import inject, { type InjectOptions, type Response } from 'light-my-request';
import { createApp } from '../src/app.js';
import * as Auth from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { setCtx } from '../src/context.js';
import { initCrypto } from '../src/crypto.js';
import { Db, migrate } from '../src/db.js';
import { createLogger } from '../src/logger.js';

export const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@127.0.0.1:54329/postgres';
export const ADMIN_PW = 'password-uji-12345';

export interface TestApp { express: Express; inject: (o: InjectOptions) => Promise<Response> }
export interface CallOpt { cookie?: string | null; headers?: Record<string, string>; csrf?: boolean; ip?: string }
export interface Harness {
  app: TestApp; db: Db; cfg: Config; cookie: string;
  call: (method: string, url: string, body?: unknown, opt?: CallOpt) => Promise<{ status: number; json: any; headers: Record<string, any> }>;
  close: () => Promise<void>;
}

/** Folder UI palsu: cukup untuk menguji penyajian berkas statis dan fallback SPA. */
function fakeUi(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-ui-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AI Ops</title><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  return dir;
}

export async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const schema = 't_' + randomBytes(5).toString('hex');
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: TEST_URL, DB_SCHEMA: schema, MASTER_KEY: randomBytes(32).toString('hex'), ADMIN_PASSWORD: ADMIN_PW,
    DATA_DIR: mkdtempSync(join(tmpdir(), 'aiops-d-')), PUBLIC_DIR: fakeUi(), ALLOWED_HOSTS: 'localhost,127.0.0.1', LOG_LEVEL: 'silent', ...env
  });
  initCrypto(cfg.MASTER_KEY, cfg.masterKeyPrevious);
  const log = createLogger('silent'), db = new Db(cfg);
  setCtx({ db, cfg, log });
  await migrate(db, join(import.meta.dirname, '..', 'migrations'), () => undefined, schema);
  await Auth.ensureAdmin(cfg);
  const express = createApp({ cfg, db, log }), app: TestApp = { express, inject: (o) => inject(express, o) };
  const h: Harness = {
    app, db, cfg, cookie: '',
    async call(method, url, body, opt = {}) {
      const headers: Record<string, string> = { host: 'localhost', ...(opt.headers ?? {}) };
      const ck = opt.cookie === undefined ? h.cookie : opt.cookie; if (ck) headers.cookie = ck;
      if (opt.csrf !== false && method !== 'GET') headers['x-aiops'] = '1';
      const r = await app.inject({ method: method as never, url, headers, remoteAddress: opt.ip, payload: body === undefined ? undefined : (body as object) });
      let json: any = null; try { json = r.json(); } catch { /* bukan JSON */ }
      return { status: r.statusCode, json, headers: r.headers as Record<string, any> };
    },
    async close() { try { await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* abaikan */ } await db.close(); }
  };
  return h;
}
export async function login(h: Harness): Promise<void> {
  const r = await h.call('POST', '/api/login', { username: h.cfg.ADMIN_USERNAME, password: ADMIN_PW }, { cookie: null });
  if (r.status !== 200) throw new Error('login uji gagal: ' + JSON.stringify(r.json));
  h.cookie = String(r.headers['set-cookie']).split(';')[0]!;
}
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until<T>(fn: () => T | Promise<T>, ms = 5000): Promise<T | null> { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(25); } return null; }
/** Detik untuk tanda tangan agen di uji: tiap panggilan berbeda (mundur, tetap di dalam jendela 5 menit) agar kirim ulang isi yang sama tidak ditolak sebagai replay. */
let tsSeq = 0;
export const agentTs = (): string => String(Math.floor(Date.now() / 1000) - (tsSeq++ % 280));

// Konteks aplikasi yang dipakai modul domain: koneksi database, konfigurasi, logger. Diisi sekali saat start (atau per uji).
import type { Config } from './config.js';
import type { Db } from './db.js';
import { setOpenFailureHandler } from './crypto.js';
import type { Logger } from './logger.js';

export interface AppCtx { db: Db; cfg: Config; log: Logger }
let current: AppCtx | null = null;
export function setCtx(c: AppCtx): void {
  current = c;
  setOpenFailureHandler((why) => c.log.warn({ why }, 'rahasia tersegel tidak bisa dibuka (kunci salah atau data rusak); nilai dianggap kosong'));
}
export function ctx(): AppCtx { if (!current) throw new Error('konteks aplikasi belum diatur'); return current; }
export const db = (): Db => ctx().db;
export const log = (): Logger => ctx().log;

export async function audit(actor: string, action: string, detail = ''): Promise<void> {
  await db().exec('INSERT INTO audit(ts,actor,action,detail) VALUES($1,$2,$3,$4)', [Date.now(), actor || 'sistem', action, String(detail).slice(0, 1000)]);
}
export async function metaGet(key: string): Promise<string | null> { const r = await db().one<{ value: string }>('SELECT value FROM meta WHERE key=$1', [key]); return r ? r.value : null; }
export async function metaSet(key: string, value: string): Promise<void> { await db().exec('INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, String(value)]); }

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const bad = (msg: string): HttpError => new HttpError(400, msg);

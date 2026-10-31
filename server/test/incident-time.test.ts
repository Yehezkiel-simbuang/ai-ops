// Waktu insiden = jam kejadian di agen. Kejadian yang tertunda di spool (aplikasi mati) tetap tercatat pada jam aslinya, dan data lama diperbaiki oleh migrasi 026.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Agents from '../src/agents.js';
import { eventTime } from '../src/incidents.js';
import { agentTs, harness, login, type Harness } from './helpers.js';

const DAY = 864e5, HOUR = 3600e3;
let h: Harness, sid = 0, keyId = '', secret = '';
beforeAll(async () => {
  h = await harness(); await login(h);
  sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-uji', host: '10.6.6.6', username: 'ops' })).json.id;
  const r = await h.call('POST', `/api/servers/${sid}/agent`, { exec: true }); keyId = r.json.keyId; secret = r.json.config.secret;
});
afterAll(async () => { await h.close(); });

async function send(events: unknown[]) {
  const path = '/agent/v1/events', raw = JSON.stringify({ events }), ts = agentTs();
  const r = await h.app.inject({ method: 'POST', url: path, headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': keyId, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(secret, ts, 'POST', path, raw) }, payload: raw });
  return { status: r.statusCode, json: r.json() };
}
let seq = 0;
const ev = (key: string, type: 'open' | 'still_open' | 'resolved', agoMs: number, over: Record<string, unknown> = {}) => ({
  id: `t${++seq}-${Math.random().toString(36).slice(2, 8)}`, type, key, title: `Tekanan ${key}`, kind: 'io', severity: 'critical', detail: `PSI ${key}`, ts: Math.floor((Date.now() - agoMs) / 1000), ...over
});
const inc = async (key: string) => (await h.db.one('SELECT * FROM incidents WHERE server_id=$1 AND key=$2 ORDER BY id DESC LIMIT 1', [sid, key]))!;
const near = (actual: number, want: number, tol = 2000) => expect(Math.abs(Number(actual) - want), `${actual} vs ${want}`).toBeLessThanOrEqual(tol);

describe('eventTime', () => {
  const R = 1_800_000_000_000;
  it('memakai jam kejadian; tidak boleh lebih baru dari saat diterima; tidak lebih tua dari 30 hari', () => {
    expect(eventTime(R / 1000 - 3600, R)).toBe(R - 3_600_000);
    expect(eventTime(R / 1000 + 600, R)).toBe(R);   // jam agen maju
    expect(eventTime(R / 1000 - 90 * 86400, R)).toBe(R - 30 * DAY);
    expect(eventTime(R / 1000, R)).toBe(R);
  });
});

describe('ingest memakai jam kejadian agen', () => {
  it('kejadian tertunda: insiden dibuka pada jam aslinya, bukan jam tiba; peringatan dan pemulihan juga', async () => {
    const open = ev('io', 'open', 5 * HOUR), still = ev('io', 'still_open', 4 * HOUR), res = ev('io', 'resolved', 3 * HOUR);
    expect((await send([open, still, res])).json).toMatchObject({ ok: true, accepted: 3 });
    const i = await inc('io');
    near(i.opened, Date.now() - 5 * HOUR); near(i.resolved_at, Date.now() - 3 * HOUR); expect(i.status).toBe('resolved'); expect(i.event_count).toBe(2);
    near(i.last_event, Date.now() - 3 * HOUR);   // pemulihan adalah kejadian terakhir
    const al = (await h.db.one("SELECT ts FROM alerts WHERE server_id=$1 AND key='ag:io' ORDER BY id DESC LIMIT 1", [sid]))!; near(al.ts, Date.now() - 5 * HOUR);
    expect(Number(i.resolved_at)).toBeGreaterThanOrEqual(Number(i.opened));
    const row = (await h.call('GET', '/api/incidents?status=resolved')).json.find((x: any) => x.id === i.id); near(row.opened, Date.now() - 5 * HOUR);   // yang dibaca UI
  });

  it('kejadian langsung (jam agen = sekarang): tercatat sekarang', async () => {
    await send([ev('mem', 'open', 0)]); near((await inc('mem')).opened, Date.now());
  });

  it('jam agen maju dibatasi sampai sekarang, jam terlalu tua dibatasi 30 hari, dan pemulihan tidak pernah lebih awal dari pembukaan', async () => {
    await send([ev('cpu', 'open', -2 * HOUR)]); near((await inc('cpu')).opened, Date.now());
    await send([ev('disk', 'open', 90 * DAY)]); near((await inc('disk')).opened, Date.now() - 30 * DAY);
    await send([ev('swap', 'open', HOUR)]); await send([ev('swap', 'resolved', 2 * HOUR)]);   // jam pemulihan lebih tua dari jam pembukaan (jam agen bergeser)
    const s = await inc('swap'); expect(s.status).toBe('resolved'); expect(Number(s.resolved_at)).toBe(Number(s.opened)); expect(Number(s.last_event)).toBeGreaterThanOrEqual(Number(s.opened));
  });

  it('kejadian still_open yang tertinggal tidak memundurkan last_event', async () => {
    await send([ev('net', 'open', 3 * HOUR)]); await send([ev('net', 'still_open', HOUR)]); const a = await inc('net');
    await send([ev('net', 'still_open', 2 * HOUR)]); const b = await inc('net');   // datang terlambat dengan jam lebih tua
    expect(Number(b.last_event)).toBe(Number(a.last_event)); expect(b.event_count).toBe(3);
  });
});

describe('migrasi 026: memperbaiki insiden lama dari agent_events', () => {
  const sql = readFileSync(join(import.meta.dirname, '..', 'migrations', '026_incident_event_times.sql'), 'utf8');

  it('satu gelombang spool: tiap insiden mendapat jam asli kejadiannya sendiri, tidak tertukar dengan tetangganya; yang tanpa kejadian dibiarkan; aman diulang', async () => {
    const B = Date.now(), T = Math.floor(B / 1000), key = 'io-lama';
    const evt = (id: string, type: string, ts: number, received: number) => h.db.exec('INSERT INTO agent_events(id,server_id,ts,type,key,received) VALUES($1,$2,$3,$4,$5,$6)', [id, sid, ts, type, key, received]);
    const tsA = T - 36_000, tsB = T - 20_000, tsC = T - 7_000;
    // urutan seperti ingest lama: received (sebelum jam dicatat), lalu insiden dicatat beberapa ms sesudahnya, semua dalam satu gelombang
    await evt('mA1', 'open', tsA, B); await evt('mA2', 'resolved', tsA + 120, B + 10);
    await evt('mB1', 'open', tsB, B + 20); await evt('mB2', 'resolved', tsB + 60, B + 30);
    await evt('mC1', 'open', tsC, B + 40); await evt('mC2', 'still_open', tsC + 300, B + 55);
    const mk = (opened: number, last: number, resolved: number | null, status: string) => h.db.one(
      `INSERT INTO incidents(server_id,key,kind,title,severity,detail,opened,last_event,resolved_at,status) VALUES($1,$2,'io','Tekanan I/O','critical','PSI',$3,$4,$5,$6) RETURNING id`, [sid, key, opened, last, resolved, status]);
    const a = await mk(B + 3, B + 12, B + 12, 'resolved'), b = await mk(B + 23, B + 32, B + 32, 'resolved'), c = await mk(B + 43, B + 57, null, 'open');
    const al = (ts: number, resolved: boolean) => h.db.exec("INSERT INTO alerts(server_id,ts,level,key,title,detail,resolved,source) VALUES($1,$2,'critical','ag:io-lama','Tekanan I/O','PSI',$3,'agent')", [sid, ts, resolved]);
    await al(B + 4, true); await al(B + 24, true); await al(B + 44, false);
    const lone = await h.db.one("INSERT INTO incidents(server_id,key,kind,title,severity,detail,opened,last_event,status) VALUES($1,'tanpa-kejadian','io','x','critical','x',$2,$2,'open') RETURNING id", [sid, B + 100]);

    await h.db.exec(sql);
    const get = async (id: number) => (await h.db.one('SELECT opened, last_event, resolved_at FROM incidents WHERE id=$1', [id]))!;
    const A = await get(a!.id), Bb = await get(b!.id), C = await get(c!.id);
    expect([A.opened, A.resolved_at, A.last_event].map(Number)).toEqual([tsA * 1000, (tsA + 120) * 1000, (tsA + 120) * 1000]);
    expect([Bb.opened, Bb.resolved_at, Bb.last_event].map(Number)).toEqual([tsB * 1000, (tsB + 60) * 1000, (tsB + 60) * 1000]);
    expect(Number(C.opened)).toBe(tsC * 1000); expect(Number(C.last_event)).toBe((tsC + 300) * 1000); expect(C.resolved_at).toBeNull();
    expect((await h.db.query("SELECT ts FROM alerts WHERE key='ag:io-lama' ORDER BY ts")).map((r) => Number(r.ts))).toEqual([tsA * 1000, tsB * 1000, tsC * 1000]);
    expect(Number((await get(lone!.id)).opened)).toBe(B + 100);   // tanpa pasangan kejadian: tidak disentuh

    const before = JSON.stringify([A, Bb, C]); await h.db.exec(sql);
    expect(JSON.stringify([await get(a!.id), await get(b!.id), await get(c!.id)])).toBe(before);   // aman diulang
  });
});

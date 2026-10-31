// Buku solusi: catatan penyebab/penyelesaian, tutup manual dengan alasan, dan insiden serupa yang muncul di insiden baru.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Agents from '../src/agents.js';
import { agentTs, harness, login, type Harness } from './helpers.js';

let h: Harness, a = 0, b = 0, keyA = '', secA = '', n = 0;
beforeAll(async () => {
  h = await harness(); await login(h);
  const mk = async (name: string, host: string) => { const id = (await h.call('POST', '/api/servers', { key_path: '/k', name, host, username: 'ops' })).json.id; const r = await h.call('POST', `/api/servers/${id}/agent`, { exec: true }); return { id, keyId: r.json.keyId, secret: r.json.config.secret }; };
  const A = await mk('srv-a', '10.7.7.1'), B = await mk('srv-b', '10.7.7.2'); a = A.id; b = B.id; keyA = A.keyId; secA = A.secret; Object.assign(creds, { [a]: A, [b]: B });
});
afterAll(async () => { await h.close(); });
const creds: Record<number, { keyId: string; secret: string }> = {};

async function send(sid: number, type: 'open' | 'resolved', key: string, over: Record<string, unknown> = {}) {
  const c = creds[sid]!, path = '/agent/v1/events', ts = agentTs();
  const raw = JSON.stringify({ events: [{ id: `n${++n}-${Math.random().toString(36).slice(2, 8)}`, type, key, title: `Tekanan ${key}`, kind: 'io', severity: 'critical', detail: 'x', ts: Math.floor(Date.now() / 1000), ...over }] });
  const r = await h.app.inject({ method: 'POST', url: path, headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': c.keyId, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(c.secret, ts, 'POST', path, raw) }, payload: raw });
  expect(r.statusCode).toBe(200);
  return (await h.db.one<{ id: number }>('SELECT id FROM incidents WHERE server_id=$1 AND key=$2 ORDER BY id DESC LIMIT 1', [sid, key]))!.id;
}
const detail = async (id: number) => (await h.call('GET', `/api/incidents/${id}`)).json;

describe('buku solusi', () => {
  it('catatan tersimpan dengan nama dan waktu; berlaku juga untuk insiden yang masih terbuka', async () => {
    const id = await send(a, 'open', 'psi-io-1');
    const r = await h.call('PUT', `/api/incidents/${id}/notes`, { cause: 'Server di-restart', solution: 'Tunggu 10 menit' });
    expect(r.status).toBe(200); expect(r.json.incident).toMatchObject({ cause: 'Server di-restart', solution: 'Tunggu 10 menit', noted_by: 'admin', status: 'open' }); expect(Number(r.json.incident.noted_at)).toBeGreaterThan(0);
    expect((await h.call('PUT', '/api/incidents/999999/notes', { cause: 'x' })).status).toBe(404);
    expect((await h.call('PUT', `/api/incidents/${id}/notes`, { cause: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('tutup manual wajib beralasan; mencatat siapa dan kenapa; tidak bisa dua kali', async () => {
    const id = await send(a, 'open', 'port-9');
    expect((await h.call('POST', `/api/incidents/${id}/close`, {})).status).toBe(400); expect((await h.call('POST', `/api/incidents/${id}/close`, { reason: 'x' })).status).toBe(400);
    const r = await h.call('POST', `/api/incidents/${id}/close`, { reason: 'Port itu layanan saya sendiri' });
    expect(r.status).toBe(200); expect(r.json.incident).toMatchObject({ status: 'resolved', closed_by: 'admin', closed_reason: 'Port itu layanan saya sendiri' }); expect(Number(r.json.incident.resolved_at)).toBeGreaterThan(0);
    expect((await h.call('POST', `/api/incidents/${id}/close`, { reason: 'lagi' })).status).toBe(400);
    const again = await send(a, 'open', 'port-9'); expect(again).not.toBe(id);   // kejadian berikutnya dari agen membuka insiden baru, tidak tertutup selamanya
  });

  it('insiden baru menampilkan insiden serupa yang sudah pulih beserta catatannya; paling mirip lebih dulu; yang tanpa catatan dan tanpa perbaikan tidak', async () => {
    const old1 = await send(a, 'open', 'disk-full'); await h.call('PUT', `/api/incidents/${old1}/notes`, { cause: 'Log membengkak', solution: 'Bersihkan /var/log' }); await send(a, 'resolved', 'disk-full');
    const old2 = await send(b, 'open', 'disk-full'); await h.call('PUT', `/api/incidents/${old2}/notes`, { cause: 'Docker image lama', solution: 'docker system prune' }); await send(b, 'resolved', 'disk-full');
    const old3 = await send(a, 'open', 'disk-other'); await h.call('PUT', `/api/incidents/${old3}/notes`, { cause: 'Beda kunci, jenis sama' }); await send(a, 'resolved', 'disk-other');
    const blank = await send(a, 'open', 'disk-blank'); await send(a, 'resolved', 'disk-blank');
    const fresh = await send(a, 'open', 'disk-full'), d = await detail(fresh);
    const sims = d.similar as Array<{ id: number; cause: string; score: number; server_name: string }>;
    expect(sims.map((s) => s.id)).toEqual([old1, old2, old3]);   // server+kunci sama, kunci sama server lain, hanya jenis sama
    expect(sims.map((s) => s.score)).toEqual([3, 2, 1]); expect(sims[0]).toMatchObject({ cause: 'Log membengkak', solution: 'Bersihkan /var/log', server_name: 'srv-a' });
    expect(sims.some((s) => s.id === blank || s.id === fresh)).toBe(false);
  });

  it('perbaikan yang dulu berhasil (langkah ubah yang selesai pada rekomendasi yang membuat insiden pulih) ikut ditampilkan, tanpa perlu catatan', async () => {
    const old = await send(b, 'open', 'svc-down', { kind: 'service' }), rec = (await h.db.one<{ id: number }>("INSERT INTO recommendations(incident_id,server_id,created,updated,status,resolved_after) VALUES($1,$2,1,1,'done',true) RETURNING id", [old, b]))!.id;
    await h.db.exec("INSERT INTO rec_steps(rec_id,n,title,command,class,status) VALUES($1,1,'Jalankan ulang nginx','sudo systemctl restart nginx','change','done'),($1,2,'Lihat status','systemctl status nginx','read','done')", [rec]);
    await send(b, 'resolved', 'svc-down', { kind: 'service' });
    const d = await detail(await send(a, 'open', 'svc-down', { kind: 'service' }));
    expect(d.similar).toHaveLength(1); expect(d.similar[0].worked).toEqual([{ title: 'Jalankan ulang nginx', command: 'sudo systemctl restart nginx' }]);   // langkah baca tidak dihitung sebagai perbaikan
  });
});

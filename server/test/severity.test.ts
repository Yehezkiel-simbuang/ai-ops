// Empat tingkat keparahan: info, minor, major, critical. Routing notifikasi, kenaikan tingkat, jam tenang, ringkasan harian, dan batas minor.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Checks from '../src/checks.js';
import * as Incidents from '../src/incidents.js';
import * as Maint from '../src/maintenance.js';
import * as Monitor from '../src/monitor.js';
import * as Notify from '../src/notify.js';
import { harness, login, sleep, type Harness } from './helpers.js';

describe('tingkat keparahan', () => {
  let h: Harness, sid: number, srv: http.Server, port: number; const got: Record<string, string[]> = {};
  const hook = (name: string) => (got[name] ??= []);
  const open = (key: string, level: 'info' | 'minor' | 'major' | 'critical', title = key) => Monitor.syncAlerts(sid, [{ key, on: true, level, title, detail: 'detail' }], 'service');
  const close = (key: string) => Monitor.syncAlerts(sid, [{ key, on: false }], 'service');
  const counts = () => Object.fromEntries(['crit', 'major', 'minor', 'info'].map((n) => [n, hook(n).length]));

  beforeAll(async () => {
    h = await harness(); await login(h);
    srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hook(req.url!.slice(1)).push(JSON.parse(b || '{}').text ?? ''); res.end('ok'); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); port = (srv.address() as AddressInfo).port;
    sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-lv', host: '10.5.5.5', username: 'ops' })).json.id;
    for (const [name, min] of [['crit', 'critical'], ['major', 'major'], ['minor', 'minor'], ['info', 'info']] as const) await Notify.save({ type: 'webhook', name, min_level: min, config: { url: `http://127.0.0.1:${port}/${name}`, format: 'slack' } });
  });
  afterAll(async () => { srv.close(); await h.close(); });
  const settle = () => sleep(250);

  it('kanal baru tanpa min_level memakai major; nilai lama atau asing ditolak, bukan diterima diam-diam', async () => {
    const r = await h.call('POST', '/api/channels', { type: 'webhook', name: 'bawaan', config: { url: `http://127.0.0.1:${port}/bawaan` } });
    expect(r.json.find((c: { name: string }) => c.name === 'bawaan').min_level).toBe('major');
    const r2 = await h.call('POST', '/api/channels', { type: 'webhook', name: 'asing', min_level: 'kritis', config: { url: `http://127.0.0.1:${port}/asing` } });
    expect(r2.json.find((c: { name: string }) => c.name === 'asing').min_level).toBe('major');   // nilai tak dikenal jatuh ke bawaan
    for (const c of r2.json.filter((x: { name: string }) => ['bawaan', 'asing'].includes(x.name))) await h.call('DELETE', `/api/channels/${c.id}`);
  });

  it('routing: tiap kanal menerima SEGERA mulai min_level-nya; info hanya sampai ke kanal info', async () => {
    await open('t:info', 'info'); await settle(); expect(counts()).toEqual({ crit: 0, major: 0, minor: 0, info: 1 });
    await open('t:minor', 'minor'); await settle(); expect(counts()).toEqual({ crit: 0, major: 0, minor: 1, info: 2 });
    await open('t:major', 'major'); await settle(); expect(counts()).toEqual({ crit: 0, major: 1, minor: 2, info: 3 });
    await open('t:crit', 'critical'); await settle(); expect(counts()).toEqual({ crit: 1, major: 2, minor: 3, info: 4 });
    expect(hook('crit')[0]).toMatch(/\[CRITICAL\]/); expect(hook('major')[0]).toMatch(/\[MAJOR\]/); expect(hook('minor')[0]).toMatch(/\[MINOR\]/);
  });

  it('pulih hanya dikabari ke kanal yang menerima tingkatnya', async () => {
    await close('t:info'); await close('t:minor'); await close('t:major'); await close('t:crit'); await settle();
    expect(hook('crit').filter((t) => /RESOLVED/.test(t))).toHaveLength(1);   // critical saja
    expect(hook('major').filter((t) => /RESOLVED/.test(t))).toHaveLength(2);   // major dan critical
    expect(hook('info').filter((t) => /RESOLVED/.test(t))).toHaveLength(4);
  });

  it('tingkat yang naik mengabari lagi menurut aturan tingkat barunya; turun tidak berisik', async () => {
    for (const k of Object.keys(got)) got[k] = [];
    await open('t:naik', 'minor'); await settle(); expect(counts()).toEqual({ crit: 0, major: 0, minor: 1, info: 1 });
    await open('t:naik', 'major'); await settle(); expect(counts()).toEqual({ crit: 0, major: 1, minor: 2, info: 2 });
    await open('t:naik', 'critical'); await settle(); expect(counts()).toEqual({ crit: 1, major: 2, minor: 3, info: 3 });
    await open('t:naik', 'minor'); await settle(); expect(counts()).toEqual({ crit: 1, major: 2, minor: 3, info: 3 });   // turun: diperbarui tanpa notifikasi
    expect((await Monitor.alerts(sid, true)).find((a: any) => a.key === 't:naik')!.level).toBe('minor');
    await close('t:naik');
  });

  it('jam tenang: major ditunda lalu dikirim sebagai SATU ringkasan setelah berakhir; critical tidak pernah ditunda', async () => {
    for (const k of Object.keys(got)) got[k] = [];
    const hr = new Date().getHours();
    await h.call('POST', '/api/settings', { quiet_on: true, quiet_start: hr, quiet_end: (hr + 2) % 24 });
    expect((await h.call('GET', '/api/settings')).json).toMatchObject({ quiet_on: true, quiet_start: hr });
    await open('q:a', 'major', 'Disk hampir penuh'); await open('q:b', 'major', 'Memori menipis'); await open('q:c', 'critical', 'Layanan mati'); await settle();
    expect(counts()).toMatchObject({ crit: 1, major: 1 });   // hanya critical yang lolos (major kanal melihat critical itu)
    expect(hook('major').join('\n')).not.toMatch(/Disk hampir penuh/);
    await close('q:b'); await settle();   // selesai selama jam tenang: tidak perlu dikabarkan
    await h.call('POST', '/api/settings', { quiet_on: false });
    await Notify.releaseDeferred(); await settle();
    const summary = hook('major').filter((t) => /selama jam tenang/.test(t) || /Disk hampir penuh/.test(t));
    expect(summary).toHaveLength(1); expect(summary[0]).toMatch(/Disk hampir penuh/); expect(summary[0]).not.toMatch(/Memori menipis/);
    const before = hook('major').length; await Notify.releaseDeferred(); await settle(); expect(hook('major')).toHaveLength(before);   // tidak dikirim dua kali
    await close('q:a'); await close('q:c');
  });

  it('ringkasan harian memuat alert minor yang masih terbuka, bukan info', async () => {
    await open('d:minor', 'minor', 'Beban sedikit tinggi'); await open('d:info', 'info', 'Layanan di-restart');
    const items = await Maint.digestItems();
    expect(items.filter((i) => i.kind === 'minor').map((i) => i.text).join('\n')).toMatch(/Beban sedikit tinggi/);
    expect(items.map((i) => i.text).join('\n')).not.toMatch(/Layanan di-restart/);
    await close('d:minor'); await close('d:info');
  });

  it('server dan ringkasan tidak menganggap info sebagai peringatan', async () => {
    await open('o:info', 'info');
    expect((await h.call('GET', '/api/servers')).json.find((s: { id: number }) => s.id === sid).open_alerts).toBe(0);
    expect((await h.call('GET', '/api/overview')).json.alerts.some((a: { key: string }) => a.key === 'o:info')).toBe(false);
    await open('o:minor', 'minor');
    expect((await h.call('GET', '/api/servers')).json.find((s: { id: number }) => s.id === sid).open_alerts).toBe(1);
    await close('o:info'); await close('o:minor');
  });

  it('kejadian agen membawa tingkatnya: info dan minor tidak menyusun rekomendasi, major dan critical menyusunnya, nilai asing = critical', async () => {
    const ev = (key: string, severity: string) => ({ id: 'e-' + key, type: 'open' as const, key, title: key, kind: 'security', severity, detail: 'd', ts: Math.floor(Date.now() / 1000) });
    await Incidents.ingest(sid, [ev('sec:a', 'info'), ev('sec:b', 'minor'), ev('sec:c', 'major'), ev('sec:d', 'critical'), ev('sec:e', 'mengada-ada')]);
    await sleep(600);
    const inc = (await h.db.query('SELECT key, severity FROM incidents WHERE server_id=$1 ORDER BY key', [sid])) as Array<{ key: string; severity: string }>;
    expect(Object.fromEntries(inc.map((i) => [i.key, i.severity]))).toEqual({ 'sec:a': 'info', 'sec:b': 'minor', 'sec:c': 'major', 'sec:d': 'critical', 'sec:e': 'critical' });
    const withRec = (await h.db.query('SELECT DISTINCT i.key FROM recommendations r JOIN incidents i ON i.id=r.incident_id WHERE i.server_id=$1', [sid])) as Array<{ key: string }>;
    expect(withRec.map((r) => r.key).sort()).toEqual(['sec:c', 'sec:d', 'sec:e']);
    const al = (await Monitor.alerts(sid, true)) as Array<{ key: string; level: string }>;
    expect(Object.fromEntries(al.filter((a) => a.key.startsWith('ag:sec:')).map((a) => [a.key, a.level]))).toMatchObject({ 'ag:sec:a': 'info', 'ag:sec:b': 'minor', 'ag:sec:c': 'major', 'ag:sec:d': 'critical' });
  });
});

describe('batas minor', () => {
  const ev = (check: Record<string, unknown>, out: string) => Checks.evaluate({ type: 'custom', params: { command: 'x' }, ...check } as never, { exitCode: 0, stdout: out, stderr: '' });
  it('evaluasi pemeriksaan: minor, major (warn), critical (crit), arah naik dan turun', () => {
    const up = { minor: 5, warn: 10, crit: 20 };
    expect(ev(up, '3').status).toBe('ok'); expect(ev(up, '7').status).toBe('minor'); expect(ev(up, '12').status).toBe('warn'); expect(ev(up, '25').status).toBe('crit');
    const down = { minor: 50, warn: 30, crit: 10, dir: 'lt' };
    expect(ev(down, '60').status).toBe('ok'); expect(ev(down, '40').status).toBe('minor'); expect(ev(down, '20').status).toBe('warn'); expect(ev(down, '5').status).toBe('crit');
    expect(ev({ warn: 10, crit: 20 }, '7').status).toBe('ok');   // tanpa minor tidak ada tingkat minor
  });
  it('urutan batas: makin parah, dengan pesan yang menyebut batas mana yang salah', () => {
    expect(Checks.orderProblem('gt', 10, 20, 5)).toBeNull(); expect(Checks.orderProblem('gt', 10, 20, null)).toBeNull(); expect(Checks.orderProblem('lt', 30, 10, 50)).toBeNull();
    expect(Checks.orderProblem('gt', 10, 20, 15)).toMatch(/major harus sama atau lebih tinggi dari batas minor/); expect(Checks.orderProblem('gt', 30, 20, 5)).toMatch(/critical harus sama atau lebih tinggi dari batas major/);
    expect(Checks.orderProblem('lt', 30, 10, 20)).toMatch(/major harus sama atau lebih rendah dari batas minor/);
  });
});

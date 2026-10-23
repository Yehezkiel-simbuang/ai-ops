import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Monitor from '../src/monitor.js';
import * as Servers from '../src/servers.js';
import * as Standards from '../src/standards.js';
import { harness, login, type Harness } from './helpers.js';

const metrics = (over: Record<string, number> = {}) => ({ nproc: 4, load5: 1, mem_avail_pct: 50, mem_total_mb: 8000, swap_used_mb: 0, disk_root_pct: 40, io_psi10: 1, ...over });
const alert = (m: Record<string, number>, limits = {}) => Object.fromEntries(Monitor.evaluate(m, {}, limits).map((c) => [c.key, c]));

describe('evaluate dengan standar', () => {
  it('bawaan: beban 1,5x dan 3x core, memori 10% dan 5%, disk 85% dan 95%, swap tanpa tingkat kritis', () => {
    expect(alert(metrics({ load5: 6.5 })).load).toMatchObject({ on: true, level: 'peringatan' }); expect(alert(metrics({ load5: 12.5 })).load).toMatchObject({ on: true, level: 'kritis' }); expect(alert(metrics({ load5: 6 })).load!.on).toBe(false);
    expect(alert(metrics({ mem_avail_pct: 9 })).mem).toMatchObject({ on: true, level: 'peringatan' }); expect(alert(metrics({ mem_avail_pct: 4 })).mem!.level).toBe('kritis');
    expect(alert(metrics({ disk_root_pct: 90 })).disk).toMatchObject({ on: true, level: 'peringatan' }); expect(alert(metrics({ disk_root_pct: 96 })).disk!.level).toBe('kritis');
    expect(alert(metrics({ swap_used_mb: 2000 })).swap).toMatchObject({ on: true, level: 'peringatan' });
  });
  it('ambang yang diubah menimpa bawaan; beban dikalikan jumlah core; memori (arah turun) tetap benar', () => {
    const a = alert(metrics({ disk_root_pct: 60, load5: 5, mem_avail_pct: 25, swap_used_mb: 300 }), { disk: { warn: 50, crit: 70 }, load: { warn: 1, crit: 2 }, mem: { warn: 30, crit: 20 }, swap: { warn: 100, crit: 200 } });
    expect(a.disk).toMatchObject({ on: true, level: 'peringatan' }); expect(a.load).toMatchObject({ on: true, level: 'peringatan' });   // 5 > 1 x 4 core, tetapi 5 < 2 x 4 core
    expect(a.mem).toMatchObject({ on: true, level: 'peringatan' }); expect(a.swap).toMatchObject({ on: true, level: 'kritis' });
  });
});

describe('urutan ambang', () => {
  it('naik berbahaya: kritis >= peringatan; turun berbahaya: kritis <= peringatan; kosong boleh', () => {
    expect(Standards.orderProblem('gt', 70, 90)).toBeNull(); expect(Standards.orderProblem('gt', 90, 70)).toMatch(/lebih tinggi/); expect(Standards.orderProblem('lt', 10, 5)).toBeNull(); expect(Standards.orderProblem('lt', 5, 10)).toMatch(/lebih rendah/);
    expect(Standards.orderProblem('gt', 70, null)).toBeNull(); expect(Standards.orderProblem('gt', 70, 70)).toBeNull();
  });
});

describe('standar global lewat API', () => {
  let h: Harness, a: number, b: number; let out = '';
  beforeAll(async () => {
    h = await harness(); await login(h);
    // meniru keluaran skrip batch: tiap pemeriksaan bernilai 65, kecuali layanan systemd yang 'active'
    const batch = (cmd: string): string => cmd.split('; o=$(').map((part, i) => (i === 0 ? part : `o=$(${part}`)).map((part) => {
      const id = /@@BEGIN (\d+)/.exec(part)?.[1]; if (!id) return '';
      return `@@BEGIN ${id}\n${/systemctl is-active/.test(part) ? 'active' : '65'}\n@@EXIT ${id} 0`;
    }).filter(Boolean).join('\n');
    Servers.setExec((async (_s: unknown, cmd: string) => ({ exitCode: 0, stdout: /@@BEGIN/.test(cmd) ? batch(cmd) : /uptime|loadavg/.test(cmd) ? out : '', stderr: '', ms: 1, timedOut: false })) as never);
    a = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-a', host: '10.3.3.3', username: 'ops' })).json.id;
    b = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-b', host: '10.3.3.4', username: 'ops' })).json.id;
    for (const id of [a, b]) await h.call('POST', `/api/servers/${id}/packs`, { pack: 'mysql', opts: {} });
  });
  afterAll(async () => { Servers.setExec(); await h.close(); });
  const std = async () => (await h.call('GET', '/api/standards')).json;
  const row = (s: any, name: string) => s.packs.flatMap((g: any) => g.checks).find((c: { name: string }) => c.name === name);
  const KEY = 'pack:mysql:MySQL: koneksi terpakai %';

  it('katalog dibangun dari paket; kunci unik; pemeriksaan hidup atau mati ditandai tanpa ambang', async () => {
    const cat = await Standards.packCatalog(); expect(new Set(cat.map((c) => c.key)).size).toBe(cat.length);
    expect(cat.find((c) => c.name === 'MySQL: koneksi terpakai %')).toMatchObject({ numeric: true, unit: '%', default: { warn: 70, crit: 90, confirm: 2 } });
    expect(cat.find((c) => c.name === 'MySQL: layanan aktif')).toMatchObject({ numeric: false });
    expect(cat.find((c) => c.name === 'Redis: memori terpakai (MB)')).toMatchObject({ unit: 'MB' });
  });

  it('GET: dasar dan paket dengan bawaan, berapa server memakainya, dan bahwa belum ada yang diubah', async () => {
    const s = await std();
    expect(s.base.map((x: { key: string }) => x.key)).toEqual(['base:load', 'base:mem', 'base:swap', 'base:disk', 'base:io']);
    expect(s.base.find((x: { key: string }) => x.key === 'base:disk')).toMatchObject({ warn: 85, crit: 95, custom: false, unit: '%', dir: 'gt' });
    expect(row(s, 'MySQL: koneksi terpakai %')).toMatchObject({ key: KEY, warn: 70, crit: 90, confirm: 2, custom: false, servers: 2, numeric: true });
    expect(s.packs.some((g: { id: string }) => g.id === 'proxmox')).toBe(false);
  });
  it('PUT: nilai valid tersimpan; urutan terbalik, di luar rentang, kunci asing, pemeriksaan hidup-mati, dan dasar tanpa peringatan ditolak; pulihkan mengembalikan bawaan', async () => {
    const put = (body: object) => h.call('PUT', '/api/standards', body);
    const ok = await put({ key: KEY, warn: 50, crit: 80, confirm: 3 }); expect(ok.status).toBe(200); expect(row(ok.json, 'MySQL: koneksi terpakai %')).toMatchObject({ warn: 50, crit: 80, confirm: 3, custom: true });
    expect((await put({ key: KEY, warn: 90, crit: 70 })).status).toBe(400); expect((await put({ key: 'base:disk', warn: 150, crit: null })).status).toBe(400); expect((await put({ key: 'base:disk', crit: 90 })).status).toBe(400);
    expect((await put({ key: 'base:mem', warn: 5, crit: 10 })).status).toBe(400); expect((await put({ key: 'base:mem', warn: 15, crit: 8 })).status).toBe(200);
    expect((await put({ key: 'pack:mysql:MySQL: layanan aktif', warn: 1 })).status).toBe(400); expect((await put({ key: 'bukan-kunci', warn: 1 })).status).toBe(400); expect((await put({ key: KEY, confirm: 99 })).status).toBe(400);
    const back = await put({ key: KEY, reset: true }); expect(row(back.json, 'MySQL: koneksi terpakai %')).toMatchObject({ warn: 70, crit: 90, confirm: 2, custom: false });
    await put({ key: 'base:mem', reset: true });
    expect((await h.call('GET', '/api/audit')).json.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['standar.ubah', 'standar.pulihkan']));
  });
  it('standar dipakai SEMUA server saat pemeriksaan: nilai 65 normal di bawaan (70), peringatan di kedua server setelah standar diturunkan, tanpa mengubah server satu per satu', async () => {
    out = 'load=0.1 0.1 0.1\nnproc=4\nmem_total_mb=8000\nmem_avail_pct=50.0\nswap_used_mb=0\ndisk_root_pct=20\nuptime_h=5\n';
    const bad = async (id: number) => (await h.call('GET', `/api/servers/${id}/monitor`)).json.alerts.filter((x: { key: string; resolved: boolean }) => /^chk:/.test(x.key) && !x.resolved);
    await h.call('PUT', '/api/standards', { key: KEY, reset: true });
    for (const id of [a, b]) { await h.call('POST', `/api/servers/${id}/check`); await h.call('POST', `/api/servers/${id}/check`); }
    expect((await bad(a)).filter((x: { title: string }) => x.title.includes('koneksi terpakai'))).toHaveLength(0);
    await h.call('PUT', '/api/standards', { key: KEY, warn: 60, crit: 99, confirm: 1 });
    for (const id of [a, b]) await h.call('POST', `/api/servers/${id}/check`);
    for (const id of [a, b]) expect((await bad(id)).filter((x: { title: string; level: string }) => x.title.includes('koneksi terpakai') && x.level === 'peringatan')).toHaveLength(1);
  });
  it('daftar pemeriksaan server menampilkan nilai yang BERLAKU dan asalnya; mengubah ambang pemeriksaan paket dari server ditolak (arahkan ke standar)', async () => {
    await h.call('PUT', '/api/standards', { key: KEY, warn: 55, crit: 85 });
    const c = (await h.call('GET', `/api/servers/${a}/checks`)).json.find((x: { name: string }) => x.name === 'MySQL: koneksi terpakai %');
    expect(c).toMatchObject({ warn: 55, crit: 85, std_source: 'global' });
    const r = await h.call('PUT', `/api/checks/${c.id}`, { warn: 10, crit: 20 }); expect(r.status).toBe(400); expect(r.json.error).toMatch(/Standar pemantauan/);
    expect((await h.call('PUT', `/api/checks/${c.id}`, { enabled: false })).status).toBe(200);   // aktif atau mati per server tetap boleh
    await h.call('PUT', '/api/standards', { key: KEY, reset: true });
    expect((await h.call('GET', `/api/servers/${b}/checks`)).json.find((x: { name: string }) => x.name === 'MySQL: koneksi terpakai %')).toMatchObject({ warn: 70, crit: 90, std_source: 'bawaan' });
  });
  it('pemeriksaan kustom tetap memakai ambangnya sendiri dan boleh diubah di tempatnya', async () => {
    await h.call('POST', `/api/servers/${a}/checks`, { name: 'Jumlah proses X', type: 'custom', params: { command: 'echo 3' }, warn: 5, crit: 9 });
    const c = (await h.call('GET', `/api/servers/${a}/checks`)).json.find((x: { name: string }) => x.name === 'Jumlah proses X');
    expect(c).toMatchObject({ warn: 5, crit: 9, std_source: 'sendiri' }); expect((await h.call('PUT', `/api/checks/${c.id}`, { warn: 7, crit: 12 })).status).toBe(200);
  });
});

describe('usulan AI untuk standar', () => {
  it('ditolak tanpa model; AI menerima data nyata; usulan yang tak berubah dibuang; yang urutannya salah ditandai bermasalah; tidak ada yang tersimpan', async () => {
    const h = await harness(); await login(h);
    try {
      expect((await h.call('POST', '/api/standards/suggest', {})).status).toBe(400);
      await h.call('POST', '/api/provider', { id: 'lain', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }); await h.call('POST', '/api/role', { role: 'monitor', provider: 'lain', model: 'm' });
      const sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-s', host: '10.9.9.9', username: 'ops' })).json.id, now = Date.now();
      for (let i = 1; i <= 40; i++) await h.db.exec('INSERT INTO metrics(server_id,ts,name,value) VALUES($1,$2,$3,$4)', [sid, now - i * 1000, 'disk_root_pct', 50 + (i % 10)]);
      let prompt = '';
      Standards.configure({ llm: (async (_r: string, req: { messages: Array<{ content: string }> }) => { prompt = req.messages[0]!.content; return { text: JSON.stringify({ suggestions: [
        { key: 'base:disk', warn: 75, crit: 90, why: 'p95 sekitar 59' }, { key: 'base:mem', warn: 10, crit: 5, why: 'tetap' }, { key: 'base:io', warn: 60, crit: 30, why: 'terbalik' }, { key: 'tidak-ada', warn: 1, crit: 2, why: '' }
      ] }), usage: { input: 1, output: 1 } }; }) as never });
      const r = await h.call('POST', '/api/standards/suggest', {}); expect(r.status).toBe(200);
      expect(prompt).toContain('base:disk'); expect(prompt).toMatch(/40 sampel dari 1 server/); expect(prompt).toContain('belum ada');
      const p = r.json.proposals as Array<{ key: string; warn: number; problem: string; current: { warn: number } }>;
      expect(p.map((x) => x.key)).toEqual(['base:disk', 'base:io']);   // yang sama dengan sekarang dan yang kuncinya asing dibuang
      expect(p[0]).toMatchObject({ warn: 75, problem: '', current: { warn: 85 } }); expect(p[1]!.problem).toMatch(/lebih tinggi/);
      expect(r.json.withData).toBe(1);
      expect((await h.call('GET', '/api/standards')).json.base.find((x: { key: string }) => x.key === 'base:disk').custom).toBe(false);   // belum tersimpan
    } finally { await h.close(); }
  });
});

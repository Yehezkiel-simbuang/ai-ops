import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Servers from '../src/servers.js';
import { harness, login, type Harness } from './helpers.js';

const CHECKS = [
  { name: 'Foo: layanan aktif', type: 'systemd', params: { unit: 'foo-agent' }, confirm: 1 },
  { name: 'Foo: jumlah antrean', type: 'custom', params: { command: 'cat /proc/loadavg | cut -d" " -f1' }, warn: 5, crit: 10 }
];
const KEY = 'pack:custom-foo-agent:Foo: jumlah antrean';

describe('layanan standar buatan sendiri', () => {
  let h: Harness, a: number, b: number;
  beforeAll(async () => {
    h = await harness(); await login(h);
    Servers.setExec((async (_s: unknown, cmd: string) => ({ exitCode: 0, stdout: /systemctl list-units/.test(cmd) ? 'unit=foo-agent.service\nunit=mysql.service\nunit=bar-daemon.service\n' : '', stderr: '', ms: 1, timedOut: false })) as never);
    a = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-a', host: '10.4.4.4', username: 'ops' })).json.id;
    b = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-b', host: '10.4.4.5', username: 'ops' })).json.id;
  });
  afterAll(async () => { Servers.setExec(); await h.close(); });
  const std = async () => (await h.call('GET', '/api/standards')).json;
  const group = (s: any) => s.packs.find((g: { id: string }) => g.id === 'custom-foo-agent');

  it('kategori: paket bawaan umum, Laravel dan layanan buatan sendiri masuk "aplikasi"; Laravel tidak lagi memuat failed_jobs', async () => {
    const s = await std(), cat = (id: string) => s.packs.find((g: { id: string }) => g.id === id)?.category;
    expect(cat('mysql')).toBe('umum'); expect(cat('laravel')).toBe('aplikasi');
    expect(s.packs.find((g: { id: string }) => g.id === 'laravel').checks.map((c: { name: string }) => c.name)).toEqual(['Aplikasi: HTTP responsif (ms)', 'Aplikasi: queue worker berjalan']);
  });

  it('sebelum disimpan: layanan tak dikenal ditandai tanpa paket; pemindaian tidak mengarang', async () => {
    const scan = (await h.call('GET', `/api/servers/${a}/scan`)).json.services as Array<{ unit: string; pack: string | null }>;
    expect(scan.find((x) => x.unit === 'foo-agent')!.pack).toBeNull(); expect(scan.find((x) => x.unit === 'mysql')!.pack).toBe('mysql'); expect(group(await std())).toBeUndefined();
  });

  it('ditolak: perintah bukan baca-saja, ambang terbalik, tipe asing, dan layanan yang sudah punya paket bawaan; tidak ada yang tersimpan', async () => {
    const post = (body: unknown) => h.call('POST', '/api/standards/packs', body);
    expect((await post({ unit: 'foo-agent', checks: [{ name: 'x', type: 'custom', params: { command: 'rm -rf /tmp/x' } }] })).status).toBe(400);
    expect((await post({ unit: 'foo-agent', checks: [{ name: 'x', type: 'custom', params: { command: 'cat /proc/loadavg' }, warn: 9, crit: 3 }] })).status).toBe(400);
    expect((await post({ unit: 'foo-agent', checks: [{ name: 'x', type: 'tidak-ada', params: {} }] })).status).toBe(400);
    expect((await post({ unit: 'mysql', checks: CHECKS })).status).toBe(400); expect((await post({ unit: 'foo agent;', checks: CHECKS })).status).toBe(400);
    expect(group(await std())).toBeUndefined();
  });

  it('simpan dari server A: masuk Standar, terpasang di A dengan nilai standar, dan dikenali di pemindaian server mana pun', async () => {
    const r = await h.call('POST', '/api/standards/packs', { unit: 'foo-agent', label: 'Foo Agent', checks: CHECKS, serverId: a });
    expect(r.status).toBe(200); expect(r.json.pack.id).toBe('custom-foo-agent'); expect(r.json.added).toEqual(['Foo: layanan aktif', 'Foo: jumlah antrean']);
    const g = group(await std()); expect(g).toMatchObject({ label: 'Foo Agent', custom: true, unit: 'foo-agent', category: 'aplikasi' }); expect(g.checks.find((c: { key: string }) => c.key === KEY)).toMatchObject({ warn: 5, crit: 10, numeric: true, servers: 1 });
    expect((await h.call('GET', `/api/servers/${a}/checks`)).json.find((c: { name: string }) => c.name === 'Foo: jumlah antrean')).toMatchObject({ pack: 'custom-foo-agent', std_source: 'bawaan', warn: 5 });
    expect(((await h.call('GET', `/api/servers/${b}/scan`)).json.services as Array<{ unit: string; pack: string | null }>).find((x) => x.unit === 'foo-agent')!.pack).toBe('custom-foo-agent');
    expect(Object.keys((await h.call('POST', `/api/servers/${b}/discover`)).json)).toContain('custom-foo-agent');
  });

  it('server B memasang dari Standar lewat jalur paket yang sama; mengulang tidak menggandakan', async () => {
    expect((await h.call('POST', `/api/servers/${b}/packs`, { pack: 'custom-foo-agent', opts: {} })).json.added).toHaveLength(2);
    expect((await h.call('POST', `/api/servers/${b}/packs`, { pack: 'custom-foo-agent', opts: {} })).json.added).toHaveLength(0);
    expect((await std() as any).packs.find((g: { id: string }) => g.id === 'custom-foo-agent').checks.find((c: { key: string }) => c.key === KEY).servers).toBe(2);
  });

  it('ambang diubah di Standar berlaku di semua server; pemeriksaan tidak bisa diubah per server', async () => {
    expect((await h.call('PUT', '/api/standards', { key: KEY, warn: 20, crit: 40 })).status).toBe(200);
    for (const id of [a, b]) expect((await h.call('GET', `/api/servers/${id}/checks`)).json.find((c: { name: string }) => c.name === 'Foo: jumlah antrean')).toMatchObject({ warn: 20, crit: 40, std_source: 'global' });
    const c = (await h.call('GET', `/api/servers/${a}/checks`)).json.find((x: { name: string }) => x.name === 'Foo: jumlah antrean');
    expect((await h.call('PUT', `/api/checks/${c.id}`, { warn: 1, crit: 2 })).status).toBe(400);
  });

  it('simpan lagi untuk unit yang sama menambah pemeriksaan, bukan menimpa semuanya', async () => {
    await h.call('POST', '/api/standards/packs', { unit: 'foo-agent', checks: [{ name: 'Foo: port 9000 terbuka', type: 'port', params: { port: 9000 } }] });
    expect(group(await std()).checks.map((c: { name: string }) => c.name)).toEqual(['Foo: layanan aktif', 'Foo: jumlah antrean', 'Foo: port 9000 terbuka']);
  });

  it('hapus dari Standar: paket hilang dan ambangnya dibersihkan; pemeriksaan yang sudah terpasang tetap jalan dengan nilainya sendiri', async () => {
    expect((await h.call('DELETE', '/api/standards/packs/custom-foo-agent')).status).toBe(200); expect(group(await std())).toBeUndefined();
    expect(await h.db.one('SELECT 1 AS x FROM global_limits WHERE key LIKE $1', ['pack:custom-foo-agent:%'])).toBeFalsy();
    expect((await h.call('GET', `/api/servers/${a}/checks`)).json.find((c: { name: string }) => c.name === 'Foo: jumlah antrean')).toMatchObject({ std_source: 'sendiri' });
    expect((await h.call('DELETE', '/api/standards/packs/custom-foo-agent')).status).toBe(400);
    expect(((await h.call('GET', `/api/servers/${a}/scan`)).json.services as Array<{ unit: string; pack: string | null }>).find((x) => x.unit === 'foo-agent')!.pack).toBeNull();
  });
});

// Pembaruan sistem: agen melaporkan fakta, aplikasi menilai menurut Standar, menghasilkan peringatan dan daftar server yang perlu dipelihara.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Agents from '../src/agents.js';
import { eolOf } from '../src/patching.js';
import { agentTs, harness, login, type Harness } from './helpers.js';

let h: Harness, sid = 0, keyId = '', secret = '';
const DAY = 864e5, NOW = Date.now();

async function patch(body: unknown, o: { key?: string } = {}) {
  const raw = JSON.stringify(body), ts = agentTs(), path = '/agent/v1/patch';
  const sig = Agents.signRequest(secret, ts, 'POST', path, raw);
  const r = await h.app.inject({ method: 'POST', url: path, headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': o.key ?? keyId, 'x-aiops-ts': ts, 'x-aiops-sig': sig }, payload: raw });
  return { status: r.statusCode, json: r.json() };
}
const facts = (o: Record<string, unknown> = {}) => ({ manager: 'apt', updates: 3, security: 0, reboot: false, os_id: 'ubuntu', os_version: '24.04', os_name: 'Ubuntu 24.04 LTS', kernel: '6.8.0', ...o });
const openKeys = async () => (await h.db.query("SELECT key, level FROM alerts WHERE server_id=$1 AND NOT resolved AND key LIKE 'patch:%' ORDER BY key", [sid])).map((a: any) => `${a.key}=${a.level}`);

beforeAll(async () => {
  h = await harness({ PUBLIC_URL: 'https://aiops.contoh.com' }); await login(h);
  sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-patch', host: '10.2.2.2', username: 'ops' })).json.id;
  const r = await h.call('POST', `/api/servers/${sid}/agent`, {}); keyId = r.json.keyId; secret = r.json.config.secret;
});
afterAll(async () => { await h.close(); });

describe('akhir masa dukungan OS', () => {
  it('Ubuntu dikenali dengan versi penuh, distro lain dengan versi utama; yang tidak dikenal tidak dinilai', () => {
    expect(eolOf('ubuntu', '22.04')).toBe(Date.UTC(2027, 6, 0)); expect(eolOf('Debian', '12')).toBe(Date.UTC(2028, 6, 0)); expect(eolOf('rocky', '9.3')).toBe(Date.UTC(2032, 5, 0));
    expect(eolOf('ubuntu', '22')).toBeNull(); expect(eolOf('alpine', '3.19')).toBeNull(); expect(eolOf(undefined, undefined)).toBeNull();
  });
});

describe('laporan pembaruan dari agen', () => {
  it('tanpa tanda tangan ditolak; laporan rusak ditolak 400', async () => {
    expect((await patch(facts(), { key: 'ak_tidakada' })).status).toBe(401);
    expect((await patch({ updates: -1 })).status).toBe(400); expect((await patch({ updates: 'banyak' })).status).toBe(400);
  });

  it('server sehat: laporan tersimpan, tidak ada peringatan, dan masuk daftar tanpa tingkat', async () => {
    expect((await patch(facts())).status).toBe(200);
    expect(await openKeys()).toEqual([]);
    const ov = (await h.call('GET', '/api/maintenance/patching')).json; const row = ov.rows.find((r: any) => r.server_id === sid);
    expect(row).toMatchObject({ name: 'srv-patch', os: 'Ubuntu 24.04 LTS', updates: 3, security: 0, reboot: false, level: null, stale: false }); expect(row.reasons).toEqual([]);
  });

  it('pembaruan keamanan menumpuk: Minor, lalu Major, lalu Critical menurut batas Standar; pulih menutup peringatan', async () => {
    await patch(facts({ security: 1 })); expect(await openKeys()).toEqual(['patch:security=minor']);   // satu pembaruan keamanan saja sudah Minor
    await patch(facts({ security: 5 })); expect(await openKeys()).toEqual(['patch:security=minor']);
    await patch(facts({ security: 11 })); expect(await openKeys()).toEqual(['patch:security=major']);
    await patch(facts({ security: 31 })); expect(await openKeys()).toEqual(['patch:security=critical']);
    await patch(facts({ security: 0 })); expect(await openKeys()).toEqual([]);
  });

  it('reboot tertunda dihitung dalam hari sejak berkas penanda; tanpa reboot menutup peringatan', async () => {
    await patch(facts({ reboot: true, reboot_since: Math.floor((NOW - 20 * DAY) / 1000) })); expect(await openKeys()).toEqual(['patch:reboot=major']);
    await patch(facts({ reboot: true, reboot_since: Math.floor((NOW - 60 * DAY) / 1000) })); expect(await openKeys()).toEqual(['patch:reboot=critical']);
    await patch(facts({ reboot: false })); expect(await openKeys()).toEqual([]);
  });

  it('OS yang sudah habis dukungannya Critical; yang masih lama tidak ada peringatan', async () => {
    await patch(facts({ os_id: 'ubuntu', os_version: '16.04', os_name: 'Ubuntu 16.04 LTS' })); expect(await openKeys()).toEqual(['patch:eol=critical']);
    await patch(facts({ os_id: 'alpine', os_version: '3.19' })); expect(await openKeys()).toEqual([]);
  });

  it('jumlah tidak diketahui (manajer paket asing) tidak dibaca sebagai nol dan tidak membuka peringatan', async () => {
    await patch({ os_id: 'alpine', os_version: '3.19', reboot: false });
    const row = (await h.call('GET', '/api/maintenance/patching')).json.rows.find((r: any) => r.server_id === sid);
    expect(row.updates).toBeNull(); expect(row.security).toBeNull(); expect(await openKeys()).toEqual([]);
  });

  it('daftar mengurutkan yang paling parah di atas, memberi alasan, dan menghitung server tanpa data', async () => {
    const sid2 = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-b', host: '10.2.2.3', username: 'ops' })).json.id;
    const a2 = (await h.call('POST', `/api/servers/${sid2}/agent`, {})).json, s2 = a2.config.secret, k2 = a2.keyId;
    const raw = JSON.stringify(facts({ security: 40, updates: 90, os_version: '22.04', os_name: 'Ubuntu 22.04' })), ts = agentTs();
    await h.app.inject({ method: 'POST', url: '/agent/v1/patch', headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': k2, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(s2, ts, 'POST', '/agent/v1/patch', raw) }, payload: raw });
    await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-tanpa-agen', host: '10.2.2.4', username: 'ops' });
    const ov = (await h.call('GET', '/api/maintenance/patching')).json;
    expect(ov.rows.map((r: any) => r.name)).toEqual(['srv-b', 'srv-patch']); expect(ov.rows[0]).toMatchObject({ level: 'critical' });
    expect(ov.rows[0].reasons[0].text).toMatch(/40 paket dengan pembaruan keamanan/); expect(ov.without_agent).toBeGreaterThanOrEqual(1);
  });

  it('mengubah batas di Standar langsung mengubah penilaian di daftar', async () => {
    await patch(facts({ security: 6 }));
    const lv = async () => (await h.call('GET', '/api/maintenance/patching')).json.rows.find((r: any) => r.server_id === sid).level;
    expect(await lv()).toBe('minor');
    await h.call('PUT', '/api/standards', { key: 'agent:patch_security', minor: 1, warn: 5, crit: 30 }); expect(await lv()).toBe('major');
    await h.call('PUT', '/api/standards', { key: 'agent:patch_security', reset: true }); expect(await lv()).toBe('minor');
  });

  it('batas pembaruan tidak ikut dikirim ke agen (dinilai aplikasi)', async () => {
    const cfg = (await h.app.inject({ method: 'GET', url: '/agent/v1/config', headers: (() => { const ts = agentTs(); return { host: 'localhost', 'x-aiops-key': keyId, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(secret, ts, 'GET', '/agent/v1/config', '') }; })() })).json();
    expect(Object.keys(cfg.limits).sort()).toEqual(['disk', 'io', 'load', 'mem', 'ssh_fail']);
  });
});

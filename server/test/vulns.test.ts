// Kerentanan yang ditutup patch: pencocokan ke OSV.dev dan CISA KEV (dipalsukan; tidak menyentuh internet).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Agents from '../src/agents.js';
import * as Patching from '../src/patching.js';
import * as Vulns from '../src/vulns.js';
import { agentTs, harness, login, type Harness } from './helpers.js';

let h: Harness, sid = 0, keyId = '', secret = '';

async function patch(body: unknown) {
  const raw = JSON.stringify(body), ts = agentTs(), path = '/agent/v1/patch';
  const r = await h.app.inject({ method: 'POST', url: path, headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': keyId, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(secret, ts, 'POST', path, raw) }, payload: raw });
  return { status: r.statusCode, json: r.json() };
}
const facts = (o: Record<string, unknown> = {}) => ({ manager: 'apt', updates: 2, security: 1, reboot: false, os_id: 'ubuntu', os_version: '24.04', os_name: 'Ubuntu 24.04 LTS', kernel: '6.8.0', packages: [{ name: 'liblzma5', source: 'xz-utils', old: '1', new: '2', sec: true }, { name: 'curl', source: 'curl', old: '1', new: '2', sec: false }], ...o });
const openKeys = async () => (await h.db.query("SELECT key, level FROM alerts WHERE server_id=$1 AND NOT resolved AND key LIKE 'patch:%' ORDER BY key", [sid])).map((a: any) => `${a.key}=${a.level}`);
const rowOf = async () => (await h.call('GET', '/api/maintenance/patching')).json.rows.find((r: any) => r.server_id === sid);

const kevIds = ['CVE-2024-0001', ...Array.from({ length: 120 }, (_, i) => `CVE-2023-${1000 + i}`)];
const osvDb: Record<string, Array<{ id: string; upstream: string[]; summary: string }>> = {
  'xz-utils@1': [{ id: 'USN-A', upstream: ['CVE-2024-0001'], summary: 'xz diperbaiki' }, { id: 'USN-B', upstream: ['CVE-2024-0002'], summary: 'xz lain' }],
  'xz-utils@2': [{ id: 'USN-B', upstream: ['CVE-2024-0002'], summary: 'xz lain' }],   // USN-B belum ada perbaikannya: tidak ditutup patch ini
  'curl@1': [], 'curl@2': []
};
let osvCalls: string[] = [], osvDown = new Set<string>(), kevCalls = 0, kevBody: unknown = { vulnerabilities: kevIds.map((cveID) => ({ cveID })) };
const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  if (url.includes('osv.dev')) {
    const b = JSON.parse(String(init!.body)) as { package: { name: string; ecosystem: string }; version: string };
    osvCalls.push(`${b.package.ecosystem}|${b.package.name}@${b.version}`);
    if (osvDown.has(b.package.name)) throw new Error('jaringan putus');
    return new Response(JSON.stringify({ vulns: osvDb[`${b.package.name}@${b.version}`] ?? [] }), { status: 200 });
  }
  kevCalls++; return new Response(JSON.stringify(kevBody), { status: 200 });
};
const reset = async () => { osvCalls = []; osvDown = new Set(); kevCalls = 0; await h.db.exec('DELETE FROM vuln_cache'); await h.db.exec('DELETE FROM kev'); await h.db.exec("DELETE FROM meta WHERE key='kev_fetched'"); await patch(facts({ updates: 0, security: 0, packages: [] })); await Patching.settled(); };

beforeAll(async () => {
  Vulns.setFetch(fakeFetch as never);
  h = await harness({ PUBLIC_URL: 'https://aiops.contoh.com' }); await login(h);
  sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-vuln', host: '10.3.3.3', username: 'ops' })).json.id;
  const r = await h.call('POST', `/api/servers/${sid}/agent`, {}); keyId = r.json.keyId; secret = r.json.config.secret;
});
afterAll(async () => { Vulns.setFetch(null); await h.close(); });

describe('kerentanan yang ditutup patch', () => {
  it('ekosistem OSV: Ubuntu LTS ditandai LTS, Debian per versi utama, distro lain tidak didukung', () => {
    expect(Vulns.ecosystemOf('ubuntu', '24.04')).toBe('Ubuntu:24.04:LTS'); expect(Vulns.ecosystemOf('ubuntu', '23.10')).toBe('Ubuntu:23.10'); expect(Vulns.ecosystemOf('ubuntu', '23.04')).toBe('Ubuntu:23.04');
    expect(Vulns.ecosystemOf('debian', '12')).toBe('Debian:12'); expect(Vulns.ecosystemOf('rocky', '9.3')).toBeNull(); expect(Vulns.ecosystemOf('alpine', '3.19')).toBeNull();
  });

  it('yang ditutup patch = menimpa versi terpasang tetapi tidak versi baru; CVE di KEV membuka peringatan Critical; yang masih terbuka tidak dihitung', async () => {
    await reset(); await patch(facts()); await Patching.settled();
    const row = await rowOf();
    expect(row.cves).toBe(1); expect(row.exploited).toBe(1); expect(row.level).toBe('critical'); expect(row.reasons[0].text).toMatch(/1 CVE di daftar CISA KEV.*liblzma5 \(CVE-2024-0001\)/);
    expect(await openKeys()).toContain('patch:exploited=critical');
    const d = (await h.call('GET', `/api/servers/${sid}/patching`)).json;
    expect(d).toMatchObject({ supported: true, ecosystem: 'Ubuntu:24.04:LTS', total: 2 }); expect(d.packages[0]).toMatchObject({ name: 'liblzma5', cves: ['CVE-2024-0001'], exploited: ['CVE-2024-0001'], unknown: false }); expect(d.packages[1]).toMatchObject({ name: 'curl', cves: [], unknown: false });
    expect(osvCalls).toContain('Ubuntu:24.04:LTS|xz-utils@1');   // ditanyakan per paket sumber, bukan paket biner liblzma5
    expect(osvCalls.some((c) => c.includes('liblzma5'))).toBe(false);
  });

  it('jawaban di-cache: laporan berikutnya tidak menanyakan lagi, dan daftar KEV tidak diunduh ulang dalam 24 jam', async () => {
    const n = osvCalls.length, k = kevCalls; await patch(facts()); await Patching.settled();
    expect(osvCalls.length).toBe(n); expect(kevCalls).toBe(k);
  });

  it('sumber tidak terjangkau = tidak diketahui, bukan "tidak ada kerentanan"; tidak membuka peringatan palsu', async () => {
    await reset(); osvDown = new Set(['xz-utils']); await patch(facts()); await Patching.settled();
    const d = (await h.call('GET', `/api/servers/${sid}/patching`)).json, row = await rowOf();
    expect(d.packages.find((p: any) => p.name === 'liblzma5')).toMatchObject({ unknown: true, cves: [] }); expect(row.vuln_unknown).toBe(1); expect(row.exploited).toBe(0);
    expect(await openKeys()).not.toContain('patch:exploited=critical');
  });

  it('peringatan "dieksploitasi" ditutup sendiri setelah patch dipasang (paket tidak lagi tertunda)', async () => {
    await reset(); await patch(facts()); await Patching.settled(); expect(await openKeys()).toContain('patch:exploited=critical');
    await patch(facts({ updates: 0, security: 0, packages: [] })); await Patching.settled(); expect(await openKeys()).toEqual([]);
  });

  it('daftar KEV yang rusak atau terlalu pendek tidak dipakai dan tidak menghapus daftar yang baik', async () => {
    await reset(); await patch(facts()); await Patching.settled(); expect((await h.db.query('SELECT cve FROM kev')).length).toBeGreaterThan(100);
    await h.db.exec("UPDATE meta SET value='0' WHERE key='kev_fetched'"); kevBody = { vulnerabilities: [{ cveID: 'CVE-2024-0001' }] };
    await patch(facts()); await Patching.settled(); expect((await h.db.query('SELECT cve FROM kev')).length).toBeGreaterThan(100); kevBody = { vulnerabilities: kevIds.map((cveID) => ({ cveID })) };
  });

  it('paket dari repositori pihak ketiga tidak ditanyakan ke OSV dan ditandai tidak bisa dicek, bukan bersih; agen lama tanpa penanda dianggap resmi', async () => {
    await reset();
    await patch(facts({ updates: 3, packages: [{ name: 'curl', source: 'curl', old: '1', new: '2', sec: false, official: true }, { name: 'docker-ce', old: '1', new: '2', sec: false, official: false }, { name: 'liblzma5', source: 'xz-utils', old: '1', new: '2', sec: true }] })); await Patching.settled();
    expect(osvCalls.some((c) => c.includes('docker-ce'))).toBe(false); expect(osvCalls.some((c) => c.includes('xz-utils'))).toBe(true);   // tanpa penanda = resmi, tetap dicek
    const d = (await h.call('GET', `/api/servers/${sid}/patching`)).json, docker = d.packages.find((p: any) => p.name === 'docker-ce');
    expect(docker).toMatchObject({ external: true, unknown: false, cves: [] }); expect(d.packages.find((p: any) => p.name === 'curl')).toMatchObject({ external: false });
    expect((await rowOf()).vuln_unknown).toBe(1);
  });

  it('distro yang belum didukung: tidak ada panggilan keluar dan jumlah CVE tidak diketahui (null), rincian tetap bisa dibuka', async () => {
    await reset(); await patch(facts({ os_id: 'alpine', os_version: '3.19', os_name: 'Alpine' })); await Patching.settled();
    expect(osvCalls).toEqual([]); expect(kevCalls).toBe(0); expect((await rowOf()).cves).toBeNull();
    const d = (await h.call('GET', `/api/servers/${sid}/patching`)).json; expect(d.supported).toBe(false); expect(d.packages).toHaveLength(2);
  });
});

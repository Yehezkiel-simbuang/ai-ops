// Cek CVE: pembanding versi dpkg, penilaian tiap server, saran, dan pemantauan perbaikan. Sumber data dan perintah SSH dipalsukan; tidak menyentuh internet.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Cve from '../src/cve.js';
import * as Servers from '../src/servers.js';
import { harness, login, until, type Harness } from './helpers.js';

const ID = 'CVE-2026-98432';
type St = { status: string; fixed?: string };
/** Bentuk JSON tracker Ubuntu (dipersingkat): paket -> status per rilis. */
const ubuntu = (pkgs: Record<string, Record<string, St>>, over: Record<string, unknown> = {}) => ({
  id: ID, description: '\nIn the Linux kernel, the following vulnerability has been resolved:\n\nipv4: free inet_opt and ireq_opt after an RCU grace period\n', published: '2026-10-15T00:00:00', updated_at: '2026-10-30T19:44:25+00:00',
  priority: 'high', cvss3: 9.8, mitigation: '', notes: [{ author: '', note: 'Priority reason:\nSee ubuntu cvss score' }], notices_ids: [], references: ['https://www.cve.org/CVERecord?id=' + ID],
  packages: Object.entries(pkgs).map(([name, rel]) => ({ name, statuses: Object.entries(rel).map(([release_codename, s]) => ({ release_codename, status: s.status, description: s.fixed ?? '', pocket: 'security', component: null })) })), ...over
});
const osv = { id: ID, summary: 'ipv4: free inet_opt and ireq_opt after an RCU grace period', details: 'UAF', published: '2026-10-15T12:08:22Z', modified: '2026-10-31T02:48:00Z', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }], affected: [{ package: { name: 'Kernel', ecosystem: 'Linux' } }] };

const PENDING = { linux: { noble: { status: 'pending', fixed: '6.8.0-149.149' }, jammy: { status: 'pending', fixed: '5.15.0-203.213' }, focal: { status: 'needed' }, upstream: { status: 'released', fixed: '7.3~rc7' } }, 'linux-aws': { noble: { status: 'pending', fixed: '6.8.0-1048.50' } } };
const RELEASED = { linux: { noble: { status: 'released', fixed: '6.8.0-149.149' }, jammy: { status: 'pending', fixed: '5.15.0-203.213' }, focal: { status: 'needed' } }, 'linux-aws': { noble: { status: 'pending', fixed: '6.8.0-1048.50' } } };

const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let net: { ubuntu: () => Response; osv: () => Response } = { ubuntu: () => reply(404), osv: () => reply(404) };
const fetchMock = async (url: string) => (url.includes('ubuntu.com/security/cves/') ? net.ubuntu() : url.includes('api.osv.dev') ? net.osv() : reply(500));

describe('pembanding versi dpkg', () => {
  it.each([
    ['6.8.0-147.153', '6.8.0-149.149', -1], ['6.8.0-149.149', '6.8.0-149.149', 0], ['6.8.0-150.150', '6.8.0-149.149', 1], ['1.0~rc1', '1.0', -1], ['1.0-1ubuntu1', '1.0-1', 1], ['1:1.0', '9.9', 1],
    ['3.0.13-0ubuntu3.4', '3.0.13-0ubuntu3.5', -1], ['3.0.13-0ubuntu3.10', '3.0.13-0ubuntu3.9', 1], ['2.4.58-1ubuntu8.5', '2.4.58-1ubuntu8.5', 0], ['1.2.3a', '1.2.3', 1], ['1.0+dfsg-1', '1.0-1', 1]
  ])('%s vs %s -> %i', (a, b, want) => expect(Math.sign(Cve.compareVersions(a, b))).toBe(want));
  it('kernel: jenis kernel, dan kernel berjalan lebih lama dari versi perbaikan menurut nomor ABI', () => {
    expect(Cve.kernelSource('6.8.0-147-generic')).toBe('linux'); expect(Cve.kernelSource('6.8.0-1048-aws')).toBe('linux-aws'); expect(Cve.kernelSource(null)).toBe('linux'); expect(Cve.kernelSource('5.15.0-203-lowlatency')).toBe('linux');
    expect(Cve.kernelBefore('6.8.0-147-generic', '6.8.0-149.149')).toBe(true); expect(Cve.kernelBefore('6.8.0-149-generic', '6.8.0-149.149')).toBe(false); expect(Cve.kernelBefore('6.8.0-152-generic', '6.8.0-149.149')).toBe(false);
    expect(Cve.kernelBefore('5.15.0-300-generic', '6.8.0-149.149')).toBe(true); expect(Cve.kernelBefore('aneh', '6.8.0-149.149')).toBeNull();
  });
  it('dpkg: ambil versi tertinggi per paket sumber dan abaikan baris rusak', () => {
    const m = Cve.parseDpkg('openssl 3.0.13-0ubuntu3.4\nopenssl 3.0.13-0ubuntu3.5\nlinux 6.8.0-147.153\n\nBAGUS?? x\n!!! 1.0\nsolo\n');
    expect(m.get('openssl')).toBe('3.0.13-0ubuntu3.5'); expect(m.get('linux')).toBe('6.8.0-147.153'); expect(m.size).toBe(2);
  });
});

describe('fakta OS dan alamat', () => {
  it('OS dari laporan agen lebih diutamakan; tanpa agen dari os_info Uji koneksi', () => {
    const a = Cve.osOf({ id: 1, name: 'a', host: '10.0.0.1', os_info: 'Linux 5.4.0-1 x86_64 | Ubuntu 20.04 LTS', agent_patch: { os_id: 'Ubuntu', os_version: '24.04', kernel: '6.8.0-147-generic' } });
    expect(a).toMatchObject({ osId: 'ubuntu', osVersion: '24.04', kernel: '6.8.0-147-generic', hasAgent: true });
    const b = Cve.osOf({ id: 2, name: 'b', host: '10.0.0.2', os_info: 'Linux 6.8.0-147-generic x86_64 | Ubuntu 24.04.4 LTS | cpu=2 | ram_mb=3915', agent_patch: null });
    expect(b).toMatchObject({ osId: 'ubuntu', osVersion: '24.04', kernel: '6.8.0-147-generic', hasAgent: false }); expect(Cve.codenameOf(b)).toBe('noble');
    expect(Cve.osOf({ id: 3, name: 'c', host: 'x', os_info: '' })).toMatchObject({ osId: null, kernel: null });
    expect(Cve.codenameOf(Cve.osOf({ id: 4, name: 'd', host: 'x', agent_patch: { os_id: 'debian', os_version: '12' } }))).toBeNull();
    expect(Cve.osOf({ id: 5, name: 'e', host: 'x', os_info: 'Linux 5.4.0-1 x86_64 | CentOS Linux 7 (Core) | cpu=2' })).toMatchObject({ osId: 'centos', osVersion: '7' });
    expect(Cve.osOf({ id: 6, name: 'f', host: 'x', os_info: 'Linux 6.1.0-1 x86_64 | Debian GNU/Linux 12 (bookworm)' })).toMatchObject({ osId: 'debian', osVersion: '12' });
    expect(Cve.osOf({ id: 7, name: 'g', host: 'x', os_info: 'Linux 6.1.0 x86_64 | Sistem Aneh' })).toMatchObject({ osId: null });
  });
  it('alamat publik: IPv4 di luar rentang privat, loopback, link-local, dan CGNAT; nama host tidak diketahui', () => {
    for (const h of ['148.230.102.209', '8.8.8.8', '172.32.0.1', '11.0.0.1']) expect(Cve.isPublicHost(h), h).toBe(true);
    for (const h of ['10.1.2.3', '172.30.2.54', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1']) expect(Cve.isPublicHost(h), h).toBe(false);
    for (const h of ['server.contoh.com', '2001:db8::1', '999.1.1.1']) expect(Cve.isPublicHost(h), h).toBeNull();
  });
});

describe('penilaian server', () => {
  const info = (pk: Record<string, Record<string, St>>, over = {}) => Cve.parseUbuntu(ubuntu(pk, over))!;
  const os = (over: Partial<Cve.ServerOs> = {}): Cve.ServerOs => ({ id: 1, name: 'srv', host: '10.0.0.5', hasAgent: false, osId: 'ubuntu', osVersion: '24.04', kernel: '6.8.0-147-generic', ...over });
  const inst = (o: Record<string, string> = {}) => new Map(Object.entries({ linux: '6.8.0-147.153', openssl: '3.0.13-0ubuntu3.4', ...o }));

  it('belum ada patch (pending): rentan tanpa patch, dengan versi yang sedang disiapkan', () => {
    const v = Cve.assessServer(info(PENDING), os(), inst());
    expect(v.verdict).toBe('rentan_tanpa_patch'); expect(v.kernelPkg).toBe(true); expect(v.release).toBe('noble');
    expect(v.packages.map((p) => p.name)).toEqual(['linux']);   // linux-aws tidak terpasang, upstream bukan rilis server
    expect(v.packages[0]!.text).toMatch(/perbaikan disiapkan di 6\.8\.0-149\.149/);
  });
  it('patch dirilis: kernel lama = rentan dan patch tersedia; kernel yang sudah di atasnya = aman', () => {
    expect(Cve.assessServer(info(RELEASED), os(), inst()).verdict).toBe('rentan_patch_tersedia');
    const ok = Cve.assessServer(info(RELEASED), os({ kernel: '6.8.0-150-generic' }), inst());
    expect(ok.verdict).toBe('aman'); expect(ok.packages[0]!.text).toMatch(/Sudah/);
  });
  it('paket biasa dinilai dari versi terpasang; yang tidak terpasang diabaikan', () => {
    const i = info({ openssl: { noble: { status: 'released', fixed: '3.0.13-0ubuntu3.5' } }, nginx: { noble: { status: 'released', fixed: '1.24.0-2ubuntu7.1' } } });
    const lama = Cve.assessServer(i, os(), inst()); expect(lama.packages.map((p) => p.name)).toEqual(['openssl']); expect(lama.verdict).toBe('rentan_patch_tersedia'); expect(lama.kernelPkg).toBe(false);
    expect(Cve.assessServer(i, os(), inst({ openssl: '3.0.13-0ubuntu3.5' })).verdict).toBe('aman');
    expect(Cve.assessServer(i, os(), new Map([['bash', '5.2']])).verdict).toBe('tidak_terdampak');
  });
  it('status lain: not-affected, DNE, ignored, needed, dan status tak dikenal', () => {
    const st = (s: string) => Cve.assessServer(info({ linux: { noble: { status: s } } }), os(), inst());
    expect(st('not-affected').verdict).toBe('tidak_terdampak'); expect(st('DNE').verdict).toBe('tidak_terdampak'); expect(st('needed').verdict).toBe('rentan_tanpa_patch');
    expect(st('ignored').verdict).toBe('rentan_tanpa_patch'); expect(st('ignored').packages[0]!.text).toMatch(/tidak akan diperbaiki/); expect(st('aneh').verdict).toBe('tidak_diketahui');
  });
  it('daftar paket tidak terbaca: hanya kernel dinilai dan diberi catatan; OS tak dikenal atau data Ubuntu tidak ada: tidak diketahui, bukan aman', () => {
    const k = Cve.assessServer(info(PENDING), os(), null, 'server tidak terjangkau'); expect(k.verdict).toBe('rentan_tanpa_patch'); expect(k.note).toMatch(/hanya kernel yang dinilai/);
    const tanpa = Cve.assessServer(info({ openssl: { noble: { status: 'released', fixed: '1' } } }), os(), null); expect(tanpa.verdict).toBe('tidak_diketahui');
    expect(Cve.assessServer(info(PENDING), os({ osId: null, osVersion: null }), inst()).verdict).toBe('tidak_diketahui');
    expect(Cve.assessServer(info(PENDING), os({ osId: 'debian', osVersion: '12' }), inst()).note).toMatch(/baru Ubuntu/);
    expect(Cve.assessServer(info(PENDING), os({ osVersion: '19.99' }), inst()).note).toMatch(/belum dikenal/);
    expect(Cve.assessServer(null, os(), inst()).note).toMatch(/tidak tersedia/);
  });
  it('rilis lain dalam satu CVE dinilai menurut rilis servernya sendiri (22.04 = jammy)', () => {
    const v = Cve.assessServer(info(PENDING), os({ osVersion: '22.04', kernel: '5.15.0-100-generic' }), inst({ linux: '5.15.0-100.110' })); expect(v.release).toBe('jammy'); expect(v.packages[0]!.text).toMatch(/5\.15\.0-203\.213/);
  });
});

describe('saran', () => {
  const srv = (over: Partial<Cve.ServerVerdict>): Cve.ServerVerdict => ({ server_id: 1, name: 'a', host: '10.0.0.1', hasAgent: false, publicHost: false, os: 'Ubuntu 24.04', release: 'noble', kernel: 'k', verdict: 'aman', packages: [], note: null, kernelPkg: false, ...over });
  const u = (m = '') => Cve.parseUbuntu(ubuntu(PENDING, { mitigation: m }))!;
  it('mitigasi resmi hanya bila Ubuntu menerbitkannya; bila kosong, dikatakan terus terang dan saran lain diberi label umum', () => {
    const a = Cve.adviceFor(u(), null, [srv({ verdict: 'rentan_tanpa_patch', kernelPkg: true })]);
    expect(a[0]).toMatchObject({ kind: 'resmi', title: 'Mitigasi dari Ubuntu' }); expect(a[0]!.text).toMatch(/tidak menerbitkan mitigasi/);
    expect(a.filter((x) => x.kind === 'resmi')).toHaveLength(1); expect(a.map((x) => x.title)).toEqual(expect.arrayContaining(['Pantau rilis patch', 'Siapkan jendela reboot', 'Cek Livepatch Ubuntu']));
    const b = Cve.adviceFor(u('Set sysctl x=0'), null, [srv({ verdict: 'rentan_tanpa_patch' })]); expect(b[0]).toMatchObject({ kind: 'resmi', text: 'Set sysctl x=0' });
  });
  it('server berIP publik atau kerentanan lewat jaringan menambah saran kurangi paparan; server privat tanpa vektor jaringan tidak', () => {
    const pub = Cve.adviceFor(u(), 'CVSS:3.1/AV:N/AC:L', [srv({ verdict: 'rentan_tanpa_patch', publicHost: true, name: 'cloud' })]);
    expect(pub.find((x) => /Kurangi paparan/.test(x.title))!.title).toMatch(/cloud/); expect(pub.find((x) => /Kurangi paparan/.test(x.title))!.text).toMatch(/lewat jaringan/);
    expect(Cve.adviceFor(u(), 'CVSS:3.1/AV:L/AC:L', [srv({ verdict: 'rentan_tanpa_patch' })]).some((x) => /Kurangi paparan/.test(x.title))).toBe(false);
    expect(Cve.adviceFor(u(), 'CVSS:3.1/AV:N/AC:L', [srv({ verdict: 'rentan_tanpa_patch' })]).some((x) => /Kurangi paparan/.test(x.title))).toBe(true);
  });
  it('patch tersedia: saran memasang dengan tautan ke halaman patch server; aman semua: tidak ada saran', () => {
    const a = Cve.adviceFor(u(), null, [srv({ server_id: 7, verdict: 'rentan_patch_tersedia', kernelPkg: true })]);
    expect(a.find((x) => /Pasang patch/.test(x.title))).toMatchObject({ link: '/patch/7' }); expect(a.find((x) => /Pasang patch/.test(x.title))!.text).toMatch(/reboot/);
    expect(Cve.adviceFor(u(), null, [srv({ verdict: 'aman' }), srv({ verdict: 'tidak_terdampak' })])).toEqual([]);
    expect(Cve.adviceFor(u(), null, [srv({ verdict: 'tidak_diketahui' })]).map((x) => x.title)).toEqual(['Lengkapi data server']);
  });
});

describe('pantau: snapshot dan perubahan', () => {
  const i = (pk: Record<string, Record<string, St>>) => Cve.parseUbuntu(ubuntu(pk))!;
  it('snapshot hanya paket dan rilis yang diminta; perubahan ke released ditandai', () => {
    const a = Cve.snapshotOf(i(PENDING), ['noble'], ['linux']), b = Cve.snapshotOf(i(RELEASED), ['noble'], ['linux']);
    expect(a).toEqual({ 'linux@noble': 'pending|6.8.0-149.149' });
    expect(Cve.diffSnapshots(a, b)).toEqual([{ pkg: 'linux', release: 'noble', from: 'pending|6.8.0-149.149', to: 'released|6.8.0-149.149', released: true }]);
    expect(Cve.diffSnapshots(b, b)).toEqual([]); expect(Cve.diffSnapshots({}, a)[0]).toMatchObject({ from: '', released: false });
    expect(Object.keys(Cve.snapshotOf(i(PENDING), ['noble', 'jammy'], [])).sort()).toEqual(['linux-aws@noble', 'linux@jammy', 'linux@noble']);   // tanpa daftar paket: semuanya
  });
});

describe('alur penuh lewat API', () => {
  let h: Harness, recv: http.Server; const hooks: string[] = [];
  const dpkgOut: Record<string, string> = {}; let ids: Record<string, number> = {};
  beforeAll(async () => {
    recv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push(JSON.parse(b).text); res.end('ok'); }); });
    await new Promise<void>((r) => recv.listen(0, '127.0.0.1', () => r())); const port = (recv.address() as AddressInfo).port;
    h = await harness(); await login(h); Cve.setFetch(fetchMock as never);
    await h.call('POST', '/api/channels', { type: 'webhook', name: 'hook', min_level: 'major', config: { url: `http://127.0.0.1:${port}/h`, format: 'slack' } });
    const mk = async (name: string, host: string, os_info: string) => { const id = (await h.call('POST', '/api/servers', { key_path: '/k', name, host, username: 'ops' })).json.id as number; await h.db.exec('UPDATE servers SET os_info=$1 WHERE id=$2', [os_info, id]); return id; };
    ids = {
      cloud: await mk('srv-cloud', '148.230.102.209', 'Linux 6.8.0-147-generic x86_64 | Ubuntu 24.04.4 LTS | cpu=2'), uji: await mk('srv-uji', '172.30.2.54', 'Linux 6.8.0-106-generic x86_64 | Ubuntu 24.04.4 LTS | cpu=2'),
      lama: await mk('srv-lama', '10.0.0.9', 'Linux 5.4.0-1 x86_64 | CentOS Linux 7'), kosong: await mk('srv-kosong', '10.0.0.10', '')
    };
    const ag = await h.call('POST', `/api/servers/${ids.uji}/agent`, { exec: true }); expect(ag.status).toBe(200);
    await h.db.exec("UPDATE agents SET patch=$1::jsonb WHERE server_id=$2", [JSON.stringify({ os_id: 'ubuntu', os_version: '24.04', kernel: '6.8.0-106-generic' }), ids.uji]);
    Servers.setExec((async (s: { name: string }) => ({ exitCode: dpkgOut[s.name] === undefined ? 255 : 0, stdout: dpkgOut[s.name] ?? '', stderr: dpkgOut[s.name] === undefined ? 'Connection refused' : '', ms: 1, timedOut: false })) as never);
    dpkgOut['srv-cloud'] = 'linux 6.8.0-147.153\nopenssl 3.0.13-0ubuntu3.4\n'; dpkgOut['srv-uji'] = 'linux 6.8.0-106.106\nopenssl 3.0.13-0ubuntu3.4\n';
  });
  afterAll(async () => { Cve.setFetch(null); Servers.setExec(); recv.close(); await h.close(); });
  afterEach(() => { net = { ubuntu: () => reply(404), osv: () => reply(404) }; });

  it('CVE yang belum ada patch: tiap server dinilai, saran ada, mitigasi resmi dinyatakan tidak ada', async () => {
    net = { ubuntu: () => reply(200, ubuntu(PENDING)), osv: () => reply(200, osv) };
    const r = await h.call('GET', `/api/cve/${ID.toLowerCase()}`); expect(r.status).toBe(200);
    const d = r.json; expect(d).toMatchObject({ id: ID, found: true, priority: 'high', cvss: 9.8, watching: false, mitigation: '' }); expect(d.summary).toMatch(/free inet_opt/); expect(d.sources).toEqual({ ubuntu: 'ok', osv: 'ok' });
    const by = (n: string) => d.servers.find((s: any) => s.name === n);
    expect(by('srv-cloud')).toMatchObject({ verdict: 'rentan_tanpa_patch', release: 'noble', publicHost: true, kernelPkg: true }); expect(by('srv-uji')).toMatchObject({ verdict: 'rentan_tanpa_patch', hasAgent: true });
    expect(by('srv-lama').verdict).toBe('tidak_diketahui'); expect(by('srv-lama').note).toMatch(/baru Ubuntu/); expect(by('srv-kosong').verdict).toBe('tidak_diketahui');
    expect(d.servers[0].verdict).toBe('rentan_tanpa_patch');   // yang paling genting di atas
    expect(d.advice[0]).toMatchObject({ kind: 'resmi' }); expect(d.advice.map((a: any) => a.title).join('|')).toMatch(/Pantau rilis patch.*Kurangi paparan jaringan: srv-cloud/);
    expect(d.matrixReleases).toContain('noble'); expect(d.releaseLabels.noble).toBe('Ubuntu 24.04'); expect(d.matrix[0].name).toBe('linux'); expect(d.matrix[0].statuses.noble).toMatchObject({ status: 'pending', fixed: '6.8.0-149.149' });
  });

  it('server yang tidak bisa dihubungi tetap dinilai dari kernelnya dan diberi catatan; bukan dianggap aman', async () => {
    net = { ubuntu: () => reply(200, ubuntu(PENDING)), osv: () => reply(404) }; const keep = dpkgOut['srv-cloud']; delete dpkgOut['srv-cloud'];
    try { const d = (await h.call('GET', `/api/cve/${ID}`)).json, s = d.servers.find((x: any) => x.name === 'srv-cloud'); expect(s.verdict).toBe('rentan_tanpa_patch'); expect(s.note).toMatch(/tidak bisa dibaca \(Connection refused\); hanya kernel yang dinilai/); expect(d.sources.osv).toBe('tidak ada'); }
    finally { dpkgOut['srv-cloud'] = keep!; }
  });

  it('format salah 400; tidak ditemukan di mana pun: found false; semua sumber gagal: 502', async () => {
    expect((await h.call('GET', '/api/cve/CVE-1')).status).toBe(400); expect((await h.call('GET', '/api/cve/bukan-cve')).status).toBe(400);
    expect((await h.call('GET', `/api/cve/${ID}`)).json).toMatchObject({ found: false, servers: [], advice: [] });
    net = { ubuntu: () => reply(500), osv: () => reply(503) }; const r = await h.call('GET', `/api/cve/${ID}`); expect(r.status).toBe(502); expect(r.json.error).toMatch(/tidak terjangkau/);
    net = { ubuntu: () => reply(500), osv: () => reply(200, osv) }; const part = (await h.call('GET', `/api/cve/${ID}`)).json;   // hanya OSV: server tidak bisa dinilai
    expect(part.found).toBe(true); expect(part.sources.ubuntu).toMatch(/^gagal/); expect(part.servers.every((s: any) => s.verdict === 'tidak_diketahui')).toBe(true);
  });

  it('pantau: tersimpan, terdaftar, ada batas, bisa dihentikan; CVE tanpa data Ubuntu ditolak', async () => {
    net = { ubuntu: () => reply(200, ubuntu(PENDING)), osv: () => reply(200, osv) };
    expect((await h.call('POST', `/api/cve/${ID}/watch`)).status).toBe(200);
    const list = (await h.call('GET', '/api/cve')).json; expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ cve: ID, notified: null }); expect(list[0].state[0]).toMatchObject({ key: 'linux@noble' });
    expect((await h.call('GET', `/api/cve/${ID}`)).json.watching).toBe(true);
    net = { ubuntu: () => reply(404), osv: () => reply(200, osv) }; expect((await h.call('POST', '/api/cve/CVE-2026-11111/watch')).status).toBe(400);
    expect((await h.call('DELETE', `/api/cve/${ID}/watch`)).status).toBe(200); expect((await h.call('GET', '/api/cve')).json).toEqual([]);
  });

  it('perbaikan dirilis: pemantau mengabari, meminta agen melapor ulang, dan tidak mengulang bila tidak ada perubahan', async () => {
    net = { ubuntu: () => reply(200, ubuntu(PENDING)), osv: () => reply(200, osv) }; await h.call('POST', `/api/cve/${ID}/watch`);
    hooks.length = 0; expect(await Cve.checkWatches()).toEqual({ checked: 1, changed: 0 }); expect(hooks).toHaveLength(0);   // tidak ada perubahan: tidak ada pesan
    net = { ubuntu: () => reply(200, ubuntu(RELEASED)), osv: () => reply(200, osv) };
    expect(await Cve.checkWatches()).toEqual({ checked: 1, changed: 1 });
    expect(await until(() => hooks.some((t) => /perbaikan dirilis untuk Ubuntu 24\.04/.test(t) && /linux \(Ubuntu 24\.04\): pending 6\.8\.0-149\.149 -> released 6\.8\.0-149\.149/.test(t) && /srv-cloud, srv-uji/.test(t)))).toBeTruthy();
    expect(await h.db.one('SELECT value FROM meta WHERE key=$1', [`patch_refresh_${ids.uji}`])).toBeTruthy();   // server berAgen diminta melapor ulang
    expect(await h.db.one('SELECT value FROM meta WHERE key=$1', [`patch_refresh_${ids.cloud}`])).toBeUndefined();   // tanpa agen: tidak ada penanda
    expect((await h.call('GET', '/api/cve')).json[0].notified).not.toBeNull();
    hooks.length = 0; expect(await Cve.checkWatches()).toEqual({ checked: 1, changed: 0 }); await new Promise((r) => setTimeout(r, 100)); expect(hooks).toHaveLength(0);
    const lookup = (await h.call('GET', `/api/cve/${ID}`)).json; expect(lookup.servers.find((s: any) => s.name === 'srv-cloud').verdict).toBe('rentan_patch_tersedia');   // kernel 147 < 149
    expect(await h.db.one("SELECT 1 AS x FROM audit WHERE action='cve.berubah'")).toBeTruthy();
  });

  it('sumber Ubuntu gagal saat pengecekan berkala: status lama dipertahankan dan dicoba lagi nanti', async () => {
    net = { ubuntu: () => reply(500), osv: () => reply(500) }; const before = (await h.db.one('SELECT snapshot, last_check FROM cve_watch WHERE cve=$1', [ID]))!;
    expect(await Cve.checkWatches()).toEqual({ checked: 1, changed: 0 }); const after = (await h.db.one('SELECT snapshot, last_check FROM cve_watch WHERE cve=$1', [ID]))!;
    expect(after.snapshot).toEqual(before.snapshot); expect(Number(after.last_check)).toBe(Number(before.last_check));
  });
});

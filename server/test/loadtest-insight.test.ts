// Uji beban dari susunan Playground: pemakaian tiap kontainer dicatat selama uji, lalu dipakai untuk menunjuk bottleneck dan menyusun arsitektur.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Sampler from '../src/loadtest/sampler.js';
import * as Store from '../src/loadtest/store.js';
import * as Servers from '../src/servers.js';
import { harness, login, until, type Harness } from './helpers.js';

const COMPOSE = [
  'services:', '  lb:', '    image: haproxy:3.0-alpine', '    ports: ["8080:80"]', '  api:', '    image: ghcr.io/akun/api:1.0', '    deploy: {resources: {limits: {cpus: "1", memory: 512m}}}',
  '  db:', '    image: postgres:17-alpine', '    deploy: {resources: {limits: {cpus: "0.5", memory: 1g}}}', ''
].join(String.fromCharCode(10));
const STATS = [
  'S|aiops-pg-1-lb-1|3.10%|20MiB / 1.9GiB', 'S|aiops-pg-1-api-1|55.00%|180MiB / 512MiB', 'S|aiops-pg-1-db-1|47.50%|600MiB / 1GiB',
  'N|aiops-pg-1-lb-1|lb', 'N|aiops-pg-1-api-1|api', 'N|aiops-pg-1-db-1|db', 'H|1.70|2|1500|1900'
].join(String.fromCharCode(10));

let h: Harness, sid = 0, pgId = 0;
const cmds: string[] = [];
const fakeExec = (out: string) => async (_s: unknown, cmd: string) => { cmds.push(cmd); return { exitCode: 0, stdout: out, stderr: '', ms: 1, timedOut: false }; };
const mk = async (name: string, playgroundId?: number) => (await h.call('POST', '/api/loadtests', { name, target: 'http://10.0.0.5:8080', confirmNotProduction: true, requests: [{ name: 'a', method: 'GET', path: '/', weight: 1 }], stages: [{ vus: 5, seconds: 10 }, { vus: 20, seconds: 10 }, { vus: 80, seconds: 10 }], criteria: { p95Ms: 500, errPct: 1 }, playgroundId })).json;
const rep = (idx: number, vus: number, t0: number, over: Record<string, number> = {}) => ({ idx, vus, seconds: 30, started: t0 + idx * 40_000, ended: t0 + idx * 40_000 + 30_000, reqs: vus * 60, rps: vus * 2, p50: 20, p95: 100, p99: 150, errPct: 0, genCpu: 0.2, scraped: {}, ...over });

beforeAll(async () => {
  h = await harness({}); await login(h);
  sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'pg-srv', host: '10.1.1.1', username: 'a', playground: true })).json.id;
  pgId = (await h.call('POST', '/api/playground', { server_id: sid, name: 'toko', compose: COMPOSE })).json.id;
});
afterAll(async () => { Sampler.setIntervalMs(5000); await h.close(); });

describe('pengambilan data pemakaian', () => {
  it('perintahnya hanya membaca, memakai proyek compose yang benar, dan keluarannya diuraikan (CPU, memori, nama layanan, server)', () => {
    const c = Sampler.command('aiops-pg-7'); expect(c).toContain('com.docker.compose.project=$P'); expect(c).toContain('P=aiops-pg-7'); expect(c).not.toMatch(/\b(rm|restart|stop|kill|exec|run)\b/);
    const p = Sampler.parse(STATS);
    expect(p.services).toEqual([{ service: 'lb', cpu: 3.1, mem_mb: 20, mem_limit_mb: expect.closeTo(1945.6, 0) }, { service: 'api', cpu: 55, mem_mb: 180, mem_limit_mb: 512 }, { service: 'db', cpu: 47.5, mem_mb: 600, mem_limit_mb: 1024 }]);
    expect(p.host).toEqual({ load: 1.7, cores: 2, mem_mb: 1500, mem_total_mb: 1900 });
    expect(Sampler.parseMem('1.5GiB')).toBe(1536); expect(Sampler.parseMem('512kB')).toBeCloseTo(0.488, 2); expect(Sampler.parseMem('abc')).toBe(0);
  });

  it('keluaran rusak atau kosong tidak menghasilkan data dan tidak melempar galat', () => {
    expect(Sampler.parse('')).toEqual({ services: [], host: null }); expect(Sampler.parse('sampah\nS|\nH|x|y').host).toBeNull();
  });
});

describe('uji dari susunan Playground', () => {
  it('ringkasan susunan menyimpan titik masuk dan batas sumber daya tiap layanan; uji tanpa susunan tidak punya arsitektur', async () => {
    const t = await mk('Toko', pgId);
    expect(t.setup.services).toEqual([{ name: 'lb', image: 'haproxy:3.0-alpine', published: true }, { name: 'api', image: 'ghcr.io/akun/api:1.0', published: false, limit: { cpus: 1, memMb: 512 } }, { name: 'db', image: 'postgres:17-alpine', published: false, limit: { cpus: 0.5, memMb: 1024 } }]);
    const bare = await mk('Tanpa susunan'); const d = (await h.call('GET', `/api/loadtests/${bare.id}`)).json; expect(d.architecture).toBeNull(); expect(d.bottleneck.findings).toEqual([]);
  });

  it('sampel disimpan per layanan dan server; hasil uji menunjuk database yang jenuh dengan bukti terukur, dan menyusun arsitektur yang disarankan', async () => {
    const t = await mk('Toko 2', pgId); cmds.length = 0; Servers.setExec(fakeExec(STATS) as never);
    await h.db.exec("UPDATE load_tests SET status='running', started=$1 WHERE id=$2", [1_000_000, t.id]);
    // pemakaian naik bersama beban; database mencapai 95% dari batas 0,5 core pada tahap 3
    const frames = [['4.0', '20.0', '10.0'], ['6.0', '40.0', '45.0'], ['9.0', '70.0', '95.0']];
    for (let i = 0; i < 3; i++) {
      Servers.setExec(fakeExec(STATS.replace('55.00%', `${frames[i]![1]}%`).replace('47.50%', `${frames[i]![2]}%`).replace('3.10%', `${frames[i]![0]}%`)) as never);
      for (let k = 0; k < 3; k++) expect(await Sampler.sampleOnce(t.id, 1_000_000 + i * 40_000 + 3_000 + k * 7_000)).toBe(4);   // 3 layanan + server
    }
    expect(cmds).toHaveLength(9); expect(cmds.every((c) => c === Sampler.command('aiops-pg-' + pgId))).toBe(true);   // satu perintah baca per sampel, ke proyek susunan itu
    expect((await h.db.query('SELECT 1 FROM load_samples WHERE test_id=$1', [t.id])).length).toBe(36);
    for (const [i, vus] of [[0, 5], [1, 20], [2, 80]] as const) await Store.addStage(t.id, rep(i, vus, 1_000_000, i === 2 ? { p95: 900, rps: 90 } : {}) as never);
    const d = (await h.call('GET', `/api/loadtests/${t.id}`)).json;
    expect(d.bottleneck.basis).toBe('terukur'); expect(d.bottleneck.findings[0]).toMatchObject({ component: 'db', role: 'db', confidence: 'terukur' });
    expect(d.bottleneck.findings[0].evidence.join(' ')).toMatch(/CPU 190%/);   // 95% CPU docker dari batas 0,5 core
    expect(d.bottleneck.usage.map((u: { service: string }) => u.service).sort()).toEqual(['_host', 'api', 'db', 'lb']);
    expect(d.architecture.changed).toBe(true); expect(d.architecture.current).toHaveLength(1);
    const adv = Object.fromEntries(d.architecture.advised.flatMap((b: { id: string; nodes: Array<{ name: string }> }) => b.nodes.map((n) => [n.name, b.id]))); expect(adv.db).toBe('data'); expect(adv.api).toBe('app1');
    expect(d.architecture.placements.find((p: { a: string; b: string }) => p.a === 'app' && p.b === 'db')).toMatchObject({ relation: 'beda' });
    await h.db.exec("UPDATE load_tests SET status='done' WHERE id=$1", [t.id]);   // supaya uji berikutnya boleh diantre
  });

  it('pengambil sampel mulai saat runner mengambil uji dan berhenti sendiri setelah uji selesai', async () => {
    Sampler.setIntervalMs(20); Servers.setExec(fakeExec(STATS) as never);
    const t = await mk('Toko 3', pgId); await h.call('POST', `/api/loadtests/${t.id}/run`);
    const job = await Store.claim(null); expect(job?.id).toBe(t.id); expect(Sampler.active(t.id)).toBe(true);
    await until(async () => (await h.db.query('SELECT 1 FROM load_samples WHERE test_id=$1', [t.id])).length >= 8);
    await h.db.exec("UPDATE load_tests SET status='done' WHERE id=$1", [t.id]);
    await until(async () => !Sampler.active(t.id)); expect(Sampler.active(t.id)).toBe(false);
  });

  it('gagal mengambil sampel tidak menggagalkan apa pun: tidak ada baris, dan hasil tetap berupa dugaan', async () => {
    Servers.setExec((async () => ({ exitCode: 255, stdout: '', stderr: 'ssh gagal', ms: 1, timedOut: false })) as never);
    const t = await mk('Toko 4', pgId); expect(await Sampler.sampleOnce(t.id)).toBe(0);
    await h.db.exec("UPDATE load_tests SET status='running', started=1000000 WHERE id=$1", [t.id]);
    for (const [i, vus] of [[0, 5], [1, 20], [2, 80]] as const) await Store.addStage(t.id, rep(i, vus, 1_000_000, i === 2 ? { p95: 900 } : {}) as never);
    const d = (await h.call('GET', `/api/loadtests/${t.id}`)).json; expect(d.bottleneck.basis).toBe('perkiraan'); expect(d.bottleneck.findings.every((f: { confidence: string }) => f.confidence === 'dugaan')).toBe(true);
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeLab } from '../src/lab/service.js';
import { harness, login, type Harness } from './helpers.js';

const projects = mkdtempSync(join(tmpdir(), 'aiops-proj-'));
mkdirSync(join(projects, 'api-saya', 'src'), { recursive: true }); writeFileSync(join(projects, 'api-saya', 'package.json'), JSON.stringify({ name: 'api-saya', dependencies: { express: '4.19.0', pg: '8.11.0', ioredis: '5.3.0' } }));
writeFileSync(join(projects, 'api-saya', 'src', 'server.js'), "const express = require('express'); const fs = require('fs'); const app = express();\napp.get('/report', (req, res) => { const d = fs.readFileSync('data.json'); res.send(d); });\napp.listen(3000);\n");
mkdirSync(join(projects, 'api-go')); writeFileSync(join(projects, 'api-go', 'main.go'), 'package main\n\nimport (\n\t"database/sql"\n\t"net/http"\n)\n\nfunc main() {\n\tdb, _ := sql.Open("pgx", "postgres://app@db/app")\n\t_ = db\n\thttp.Get("https://api.pembayaran.example.com/charge")\n}\n');
writeFileSync(join(projects, 'api-go', 'go.mod'), 'module example.com/api\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/jackc/pgx/v5 v5.5.0\n\tgithub.com/redis/go-redis/v9 v9.5.0\n)\n');
mkdirSync(join(projects, 'api-py')); writeFileSync(join(projects, 'api-py', 'requirements.txt'), 'fastapi==0.110.0\nuvicorn==0.29.0\nsqlalchemy==2.0.29\npsycopg2-binary==2.9.9\ncelery==5.3.6\n');
mkdirSync(join(projects, 'catatan')); writeFileSync(join(projects, 'catatan', 'README.md'), 'bukan proyek');
mkdirSync(join(projects, '.rahasia')); writeFileSync(join(projects, '.rahasia', 'package.json'), '{}');

describe('lab arsitektur', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness({ PROJECTS_ROOT: projects }); await login(h); });
  afterAll(async () => { await closeLab(); await h.close(); });

  const load = (users: number, extra: object = {}) => ({ users, rpu: 6, mix: { browse: 95, checkout: 4.5, report: 0.5 }, spike: { on: false, mult: 4, at: 15, len: 45, every: 0, shape: 'step' }, ...extra });

  it('semua rute lab wajib sesi', async () => {
    expect((await h.call('GET', '/api/lab/projects', undefined, { cookie: null })).status).toBe(401);
    expect((await h.call('POST', '/api/lab/simulate', {}, { cookie: null })).status).toBe(401);
  });

  it('daftar proyek: contoh + folder yang punya manifest (tanpa folder tersembunyi atau bukan proyek)', async () => {
    const r = await h.call('GET', '/api/lab/projects');
    expect(r.status).toBe(200); expect(r.json.foldersEnabled).toBe(true);
    const ids = r.json.projects.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['contoh-api-sederhana', 'contoh-toko-online', 'contoh-web-hdd', 'folder:api-saya']));
    expect(ids).not.toContain('folder:catatan'); expect(ids).not.toContain('folder:.rahasia');
  });

  it('detail proyek: arsitektur, rekomendasi awal, katalog komponen, beban dan lama simulasi bawaan', async () => {
    const r = await h.call('GET', '/api/lab/projects/contoh-toko-online');
    expect(r.status).toBe(200);
    expect(r.json.arch.nodes.length).toBeGreaterThan(5);
    expect(r.json.recs.map((x: { id: string }) => x.id)).toContain('split-api');
    expect(r.json.recommendedIds.length).toBeGreaterThan(0);
    expect(r.json.catalog.map((c: { id: string }) => c.id)).toEqual(['redis', 'lb', 'filter', 'replica', 'hadb', 'dbsplit', 'queue', 'scaleup', 'ssd', 'cdn']);
    expect(r.json.load.users).toBeGreaterThan(0); expect(r.json.faultsAssumed).toBe(true); expect(r.json.seconds).toBe(120);
    const hdd = await h.call('GET', '/api/lab/projects/contoh-web-hdd'); expect(hdd.json.faultsAssumed).toBe(false); expect(hdd.json.seconds).toBe(300);
  });

  it('proyek dari folder dianalisis; folder di luar PROJECTS_ROOT dan id aneh ditolak', async () => {
    const r = await h.call('GET', '/api/lab/projects/' + encodeURIComponent('folder:api-saya'));
    expect(r.status).toBe(200); expect(r.json.arch.workloads.length).toBeGreaterThan(0); expect(r.json.stack.join(' ')).toMatch(/Node|Express/i);
    for (const id of ['folder:../etc', 'folder:..', 'folder:/etc', 'tidak-ada', 'folder:']) expect((await h.call('GET', '/api/lab/projects/' + encodeURIComponent(id))).status, id).toBe(400);
  });

  it('berlaku untuk tumpukan apa pun: Node, Go, Python dianalisis tanpa istilah PHP/Laravel/Proxmox/ZFS/RADIUS yang terbawa', async () => {
    for (const name of ['api-saya', 'api-go', 'api-py']) {
      const r = await h.call('GET', '/api/lab/projects/' + encodeURIComponent('folder:' + name));
      expect(r.status, name).toBe(200); expect(r.json.arch.nodes.length, name).toBeGreaterThan(3); expect(r.json.arch.workloads.length, name).toBeGreaterThan(0);
      const text = JSON.stringify({ recs: r.json.recs, nodes: r.json.arch.nodes, wl: r.json.arch.workloads, faults: r.json.faults });
      expect(text, name).not.toMatch(/PHP|Laravel|FPM|Proxmox|ZFS|RADIUS|Billing|InnoDB/i);   // ("slog" sebagai nama properti disk tidak dihitung)
      if (name !== 'api-py') expect(r.json.recs.length, name + ': temuan dari kode harus ada').toBeGreaterThan(0);
      expect(r.json.catalog.filter((c: { available: boolean }) => c.available).length, name).toBeGreaterThanOrEqual(4);
    }
  });

  it('simulasi menghasilkan kondisi awal dan eksperimen dengan bingkai per detik', async () => {
    const r = await h.call('POST', '/api/lab/simulate', { project: 'contoh-toko-online', actions: [], load: load(700), seconds: 40, faults: false });
    expect(r.status).toBe(200);
    for (const run of [r.json.baseline, r.json.experiment]) {
      expect(run.frames.length).toBe(39); expect(run.edges.length).toBeGreaterThan(5); expect(run.summary.fastPct).toBeGreaterThan(90);
      expect(run.frames[0].nodes).toBeTruthy();
    }
    expect(r.json.applied).toEqual([]);
  });

  it('eksperimen: Redis + load balancer memperbaiki beban tinggi; kondisi awal tetap sama dan di-cache', async () => {
    const body = { project: 'contoh-toko-online', load: load(3000), seconds: 60, faults: false };
    const a = await h.call('POST', '/api/lab/simulate', { ...body, actions: [{ kind: 'component', component: 'redis', params: { hit: 90 } }] });
    expect(a.status).toBe(200);
    expect(a.json.baseline.summary.fastPct).toBeLessThan(50);
    expect(a.json.experiment.summary.fastPct).toBeGreaterThan(90);
    expect(a.json.applied[0]).toMatchObject({ kind: 'component', component: 'redis' });
    const b = await h.call('POST', '/api/lab/simulate', { ...body, actions: [{ kind: 'component', component: 'lb', params: { instances: 3 } }] });
    expect(b.json.baseline.summary).toEqual(a.json.baseline.summary);   // kondisi awal sama persis (hasil di-cache)
    expect(b.json.experiment.arch.nodes.some((n: { id: string }) => n.id === 'x-lb')).toBe(true);
    expect(b.json.baseline.arch.nodes.some((n: { id: string }) => n.id === 'x-lb')).toBe(false);
  });

  it('rekomendasi bisa dipakai sebagai aksi; komponen tak berlaku dan duplikat dilaporkan, bukan gagal', async () => {
    const detail = (await h.call('GET', '/api/lab/projects/contoh-toko-online')).json;
    const r = await h.call('POST', '/api/lab/simulate', {
      project: 'contoh-toko-online', load: load(300), seconds: 30, faults: false,
      actions: [...detail.recommendedIds.map((id: string) => ({ kind: 'rec', id })), { kind: 'rec', id: 'tidak-ada' }, { kind: 'component', component: 'ssd', params: {} }, { kind: 'component', component: 'redis' }, { kind: 'component', component: 'redis', params: { hit: 60 } }]
    });
    expect(r.status).toBe(200);
    expect(r.json.applied.filter((x: { kind: string }) => x.kind === 'rec').length).toBe(detail.recommendedIds.length);
    expect(r.json.skipped.map((x: { reason: string }) => x.reason).join(' | ')).toMatch(/tidak ditemukan.*NVMe.*sama/);
  });

  it('masukan tidak valid ditolak dengan pesan jelas', async () => {
    const ok = { project: 'contoh-toko-online', actions: [], load: load(100), seconds: 30 };
    expect((await h.call('POST', '/api/lab/simulate', { ...ok, load: load(100000) })).json.error).toMatch(/Beban puncak melebihi batas/);
    expect((await h.call('POST', '/api/lab/simulate', { ...ok, load: load(100, { spike: { on: true, mult: 10, at: 1, len: 5, every: 0, shape: 'step' } }) })).status).toBe(200);   // 10 rps x10: aman
    expect((await h.call('POST', '/api/lab/simulate', { ...ok, seconds: 5 })).status).toBe(400);
    expect((await h.call('POST', '/api/lab/simulate', { ...ok, actions: [{ kind: 'component', component: 'rm-rf' }] })).status).toBe(400);
    expect((await h.call('POST', '/api/lab/simulate', { ...ok, actions: Array.from({ length: 21 }, () => ({ kind: 'rec', id: 'x' })) })).status).toBe(400);
    expect((await h.call('POST', '/api/lab/simulate', { ...ok, project: 'tidak-ada' })).status).toBe(400);
  });

  it('skenario kegagalan: matikan database; HA mempersingkat gangguan; kondisi awal tidak berubah oleh komponen', async () => {
    const body = { project: 'contoh-toko-online', load: load(500), seconds: 100, faults: false, failure: { node: 'pg', at: 30, len: 40 } };
    const a = await h.call('POST', '/api/lab/simulate', { ...body, actions: [{ kind: 'component', component: 'hadb', params: { failoverS: 20, warmS: 20 } }] });
    expect(a.status).toBe(200);
    expect(a.json.baseline.summary.outageSeconds).toBeGreaterThanOrEqual(35);
    expect(a.json.experiment.summary.outageSeconds).toBeLessThanOrEqual(25);
    expect(a.json.baseline.failure).toMatchObject({ node: 'pg', at: 30, len: 40, skipped: null });
    expect(a.json.experiment.frames.some((f: { states?: Record<string, string> }) => f.states?.pg === 'failover')).toBe(true);
    const lb = await h.call('POST', '/api/lab/simulate', { ...body, failure: { node: 'api', at: 30, len: 40 }, actions: [{ kind: 'component', component: 'lb', params: { instances: 3 } }] });
    expect(lb.json.baseline.summary.outageSeconds).toBeGreaterThanOrEqual(35); expect(lb.json.experiment.summary.outageSeconds).toBeLessThanOrEqual(2);
    const miss = await h.call('POST', '/api/lab/simulate', { ...body, failure: { node: 'x-lb', at: 5, len: 10 }, actions: [] });
    expect(miss.json.baseline.failure.skipped).toMatch(/tidak ada/);
    expect((await h.call('POST', '/api/lab/simulate', { ...body, failure: { node: 'pg', at: 999, len: 10 } })).status).toBe(400);
    expect((await h.call('POST', '/api/lab/simulate', { ...body, actions: [{ kind: 'component', component: 'filter', params: { blockPct: 30 } }, { kind: 'component', component: 'dbsplit', params: {} }] })).status).toBe(200);
  });

  it('potensi bottleneck: urutan jenuh untuk kondisi sekarang dan eksperimen, di-cache, masukan buruk ditolak', async () => {
    const body = { project: 'contoh-toko-online', actions: [{ kind: 'component', component: 'redis', params: { hit: 90 } }], load: load(400) };
    const a = await h.call('POST', '/api/lab/bottlenecks', body); expect(a.status).toBe(200);
    expect(a.json.baseline.ranking[0]).toMatchObject({ node: 'api', label: expect.any(String) }); expect(a.json.baseline.ranking[0].share).toBeGreaterThan(0.5);
    expect(a.json.baseline.variations).toBeGreaterThan(0); expect(a.json.baseline.varied.length).toBeGreaterThan(0);
    expect(a.json.experiment.ranking[0].medianMultiple).toBeGreaterThanOrEqual(a.json.baseline.ranking[0].medianMultiple);
    const b = await h.call('POST', '/api/lab/bottlenecks', body); expect(b.json).toEqual(a.json);
    expect((await h.call('POST', '/api/lab/bottlenecks', { ...body, load: load(100000) })).status).toBe(400);
    expect((await h.call('POST', '/api/lab/bottlenecks', { ...body, project: 'tidak-ada' })).status).toBe(400);
    expect((await h.call('POST', '/api/lab/bottlenecks', { ...body, actions: [{ kind: 'x' }] })).status).toBe(400);
  });

  it('skenario tersimpan: simpan, perbarui bila namanya sama, daftar per proyek, hapus', async () => {
    const d = { project: 'contoh-toko-online', name: 'Redis + LB', actions: [{ kind: 'component', component: 'redis', params: { hit: 80 } }], load: load(500), faults: false, seconds: 60, failure: { node: 'pg', at: 20, len: 30 } };
    const a = await h.call('POST', '/api/lab/designs', d); expect(a.status).toBe(200); expect(a.json.id).toBeGreaterThan(0);
    const b = await h.call('POST', '/api/lab/designs', { ...d, seconds: 90 }); expect(b.json.id).toBe(a.json.id); expect(b.json.seconds).toBe(90);
    await h.call('POST', '/api/lab/designs', { ...d, project: 'contoh-web-hdd', name: 'lain' });
    const list = await h.call('GET', '/api/lab/designs?project=contoh-toko-online');
    expect(list.json.map((x: { name: string }) => x.name)).toEqual(['Redis + LB']); expect(list.json[0].actions[0].component).toBe('redis'); expect(list.json[0].failure).toEqual({ node: 'pg', at: 20, len: 30 });
    expect((await h.call('POST', '/api/lab/designs', { ...d, name: '   ' })).status).toBe(400);
    expect((await h.call('DELETE', `/api/lab/designs/${a.json.id}`)).status).toBe(200);
    expect((await h.call('GET', '/api/lab/designs?project=contoh-toko-online')).json).toEqual([]);
  });
});

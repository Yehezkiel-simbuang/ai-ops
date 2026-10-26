import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Estimate from '../src/lab/estimate.js';
import { closeLab, withEstimates } from '../src/lab/service.js';
import { estimateSchema } from '../src/lab/types.js';
import { harness, login, type Harness } from './helpers.js';

const projects = mkdtempSync(join(tmpdir(), 'aiops-est-'));
const dir = join(projects, 'api-saya');
mkdirSync(join(dir, 'src'), { recursive: true }); mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'api-saya', dependencies: { express: '4.19.0', pg: '8.11.0' } }));
writeFileSync(join(dir, 'src', 'server.js'), "const express = require('express'); const { Pool } = require('pg'); const app = express(); const pool = new Pool();\napp.get('/produk', async (req, res) => { const r = await pool.query('select * from produk'); res.json(r.rows); });\napp.listen(3000);\n");
writeFileSync(join(dir, '.env.example'), 'DB_HOST=db\nDB_PASSWORD=rahasia-banget\nDATABASE_URL=postgres://app:sandi-rahasia@db:5432/app\nDB_POOL_MAX=25\n');
writeFileSync(join(dir, '.env'), 'DB_PASSWORD=jangan-dibaca\n');
writeFileSync(join(dir, 'node_modules', 'x', 'package.json'), '{}');

describe('berkas bukti', () => {
  it('rahasia disamarkan, .env asli dan node_modules tidak dibaca', () => {
    const files = Estimate.collectFiles(dir), names = files.map((f) => f.file);
    expect(names).toEqual(expect.arrayContaining(['.env.example', 'package.json'])); expect(names).not.toContain('.env'); expect(names.some((n) => n.startsWith('node_modules'))).toBe(false);
    const env = files.find((f) => f.file === '.env.example')!.lines.join('\n');
    expect(env).not.toContain('rahasia-banget'); expect(env).not.toContain('sandi-rahasia'); expect(env).toContain('DB_POOL_MAX=25');
  });
  it('kutipan bukti hanya sah bila ada di baris itu pada berkas yang dibaca', () => {
    const files = [{ file: 'a.env', lines: ['X=1', 'DB_POOL_MAX=25', 'Y=2'] }];
    expect(Estimate.verifyQuote(files, 'a.env', 2, 'db_pool_max=25')).toBe(true);
    expect(Estimate.verifyQuote(files, 'a.env', 3, 'DB_POOL_MAX=25')).toBe(true);   // toleransi satu baris
    expect(Estimate.verifyQuote(files, 'a.env', 2, 'DB_POOL_MAX=99')).toBe(false);
    expect(Estimate.verifyQuote(files, 'lain.env', 2, 'DB_POOL_MAX=25')).toBe(false);
    expect(Estimate.verifyQuote(files, 'a.env', 0, 'X=1')).toBe(false);
  });
});

describe('menerapkan estimasi', () => {
  const arch = { nodes: [{ id: 'db', connections: 100, hotKeys: 5, assumed: ['connections'] }], workloads: [] };
  it('hanya parameter yang ditandai tebakan yang diganti, dan tandanya dicabut; aslinya tidak berubah', () => {
    const out = withEstimates(arch, [{ node: 'db', key: 'connections', value: 25 }, { node: 'db', key: 'hotKeys', value: 999 }, { node: 'x', key: 'a', value: 1 }]) as typeof arch;
    expect(out.nodes[0]).toMatchObject({ connections: 25, hotKeys: 5, assumed: [] }); expect(arch.nodes[0]!.connections).toBe(100);
  });
});

describe('estimasi waktu CPU per workload', () => {
  const arch = { nodes: [{ id: 'db', connections: 100 }], workloads: [{ id: 'read', cpuMs: 8, cpuAssumed: true }, { id: 'jobs', async: true }] };
  it('mengganti cpuMs workload dan menandainya bukan tebakan; aslinya tidak berubah', () => {
    const out = withEstimates(arch, [{ node: 'read', key: 'cpuMs', value: 14, scope: 'workload' }]) as typeof arch;
    expect(out.workloads[0]).toMatchObject({ cpuMs: 14, cpuAssumed: false }); expect(arch.workloads[0]).toMatchObject({ cpuMs: 8, cpuAssumed: true });
  });
  it('workload tanpa cpuMs atau yang tidak ada diabaikan; id yang sama dengan node tidak tertukar', () => {
    const out = withEstimates(arch, [{ node: 'jobs', key: 'cpuMs', value: 5, scope: 'workload' }, { node: 'nope', key: 'cpuMs', value: 5, scope: 'workload' }, { node: 'db', key: 'cpuMs', value: 5, scope: 'workload' }]) as typeof arch;
    expect(out.workloads[1]).toEqual({ id: 'jobs', async: true }); expect(out.nodes[0]).toEqual({ id: 'db', connections: 100 });
  });
  it('skema hanya menerima cpuMs untuk workload, dan scope bawaan adalah node', () => {
    expect(estimateSchema.safeParse({ node: 'read', key: 'rate', value: 5, scope: 'workload' }).success).toBe(false);
    expect(estimateSchema.safeParse({ node: 'read', key: 'cpuMs', value: 5, scope: 'workload' }).success).toBe(true);
    expect(estimateSchema.parse({ node: 'db', key: 'connections', value: 5 }).scope).toBe('node');
  });
});

describe('estimasi AI lewat API', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness({ PROJECTS_ROOT: projects }); await login(h); });
  afterAll(async () => { await closeLab(); await h.close(); });

  it('ditolak tanpa model, dan untuk contoh bawaan', async () => {
    expect((await h.call('POST', '/api/lab/estimate', { project: 'folder:api-saya' })).status).toBe(400);
    await h.call('POST', '/api/provider', { id: 'lain', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }); await h.call('POST', '/api/role', { role: 'monitor', provider: 'lain', model: 'm-murah' });
    expect((await h.call('POST', '/api/lab/estimate', { project: 'contoh-api-sederhana' })).status).toBe(400);
  });
  it('usulan diverifikasi: bukti cocok mempertahankan keyakinan, bukti palsu dipaksa rendah, parameter non-tebakan dibuang; rahasia tidak dikirim ke model', async () => {
    const detail = (await h.call('GET', '/api/lab/projects/' + encodeURIComponent('folder:api-saya'))).json;
    const target = detail.arch.nodes.flatMap((n: { id: string; assumed?: string[] }) => (n.assumed ?? []).map((k) => ({ node: n.id, key: k })))[0];
    expect(target).toBeTruthy();
    let sent = '';
    Estimate.configure({ llm: (async (_r: string, req: { messages: Array<{ content: string }> }) => {
      sent = req.messages[0]!.content;
      const e = (over: object) => ({ ...target, value: 25, confidence: 'tinggi', file: '.env.example', line: 4, quote: 'DB_POOL_MAX=25', reason: 'tertulis', ...over });
      return { text: 'Ini hasilnya:\n' + JSON.stringify({ estimates: [e({}), e({ key: 'bukan-tebakan' }), e({ quote: 'DB_POOL_MAX=77' })] }), usage: { input: 1, output: 1 } };
    }) as never });
    const r = await h.call('POST', '/api/lab/estimate', { project: 'folder:api-saya' });
    expect(r.status).toBe(200); expect(r.json).toMatchObject({ role: 'monitor', model: 'm-murah' });
    expect(r.json.estimates).toHaveLength(2);
    expect(r.json.estimates[0]).toMatchObject({ ...target, value: 25, confidence: 'tinggi', verified: true });
    expect(r.json.estimates[1]).toMatchObject({ confidence: 'rendah', verified: false });
    expect(sent).toContain('DB_POOL_MAX=25'); expect(sent).not.toContain('rahasia-banget'); expect(sent).not.toContain('sandi-rahasia'); expect(sent).not.toContain('jangan-dibaca');
  });
  it('simulasi memakai estimasi yang diterima', async () => {
    const detail = (await h.call('GET', '/api/lab/projects/' + encodeURIComponent('folder:api-saya'))).json;
    const target = detail.arch.nodes.flatMap((n: { id: string; assumed?: string[] }) => (n.assumed ?? []).map((k) => ({ node: n.id, key: k })))[0];
    const r = await h.call('POST', '/api/lab/simulate', { project: 'folder:api-saya', estimates: [{ ...target, value: 3 }], load: detail.load, seconds: 30, faults: false });
    expect(r.status).toBe(200);
    const node = r.json.experiment.arch.nodes.find((n: { id: string }) => n.id === target.node); expect(node[target.key]).toBe(3); expect(node.assumed ?? []).not.toContain(target.key);
  });
});

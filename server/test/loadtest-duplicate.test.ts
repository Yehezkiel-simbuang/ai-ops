// Salinan uji ("ulang") harus tetap terhubung ke susunan Playground. Sebelumnya setup dan playground_id hilang, sehingga uji ulang tidak punya
// arsitektur, diagram langsung, sampel CPU kontainer, putar ulang, maupun analisis bottleneck.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, login, type Harness } from './helpers.js';

const COMPOSE = 'services:\n  app:\n    image: x:1\n    ports: ["8080:80"]\n    deploy: {resources: {limits: {cpus: "0.5", memory: 512m}}}\n';
let h: Harness, pgId = 0, srv = 0;
beforeAll(async () => {
  h = await harness({ LOADGEN_SECRET: 'rahasia-runner-uji-yang-cukup-panjang-123' }); await login(h);
  srv = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'pg-dup', host: '10.1.1.1', username: 'a', playground: true })).json.id;
  pgId = (await h.call('POST', '/api/playground', { server_id: srv, name: 'dgn-redis', compose: COMPOSE })).json.id;
});
afterAll(async () => { await h.close(); });

const mk = async (name: string, playgroundId?: number) => (await h.call('POST', '/api/loadtests', { name, target: 'http://10.0.0.5:8080', confirmNotProduction: true, requests: [{ name: 'a', method: 'GET', path: '/', weight: 1 }], stages: [{ vus: 5, seconds: 10 }], playgroundId })).json;
const row = async (id: number) => (await h.db.one('SELECT setup, playground_id FROM load_tests WHERE id=$1', [id]))!;

describe('salin uji', () => {
  it('uji dari susunan Playground: salinan tetap menaut ke susunan itu dan membawa ringkasannya', async () => {
    const a = await mk('A', pgId), copy = (await h.call('POST', `/api/loadtests/${a.id}/duplicate`)).json;
    expect(copy.name).toBe('A (ulang)'); const r = await row(copy.id);
    expect(Number(r.playground_id)).toBe(pgId); expect(r.setup).toMatchObject({ name: 'dgn-redis', services: [{ name: 'app', image: 'x:1', published: true }] });
    const d = (await h.call('GET', `/api/loadtests/${copy.id}`)).json; expect(d.architecture.nodes.map((n: any) => n.name)).toEqual(['app']);   // arsitektur ada: diagram langsung bisa tampil
  });

  it('ringkasan diambil ulang bila susunan sudah diubah sejak uji pertama', async () => {
    const a = await mk('B', pgId); await h.call('PUT', `/api/playground/${pgId}`, { compose: COMPOSE.replace('x:1', 'x:2') });
    const r = await row((await h.call('POST', `/api/loadtests/${a.id}/duplicate`)).json.id); expect(r.setup).toMatchObject({ services: [{ image: 'x:2' }] });
  });

  it('susunan sudah dihapus: ringkasan lama dipertahankan (arsitektur tetap tergambar) tetapi tanpa tautan sampel', async () => {
    const pg2 = (await h.call('POST', '/api/playground', { server_id: srv, name: 'sementara', compose: COMPOSE })).json.id, a = await mk('C', pg2);
    await h.db.exec('DELETE FROM playground_deploys WHERE id=$1', [pg2]);
    const r = await row((await h.call('POST', `/api/loadtests/${a.id}/duplicate`)).json.id); expect(r.playground_id).toBeNull(); expect(r.setup).toMatchObject({ name: 'sementara' });
  });

  it('uji tanpa susunan: salinan juga tanpa susunan (tidak ada yang dikarang)', async () => {
    const a = await mk('D'), r = await row((await h.call('POST', `/api/loadtests/${a.id}/duplicate`)).json.id); expect(r.setup).toBeNull(); expect(r.playground_id).toBeNull();
  });
});

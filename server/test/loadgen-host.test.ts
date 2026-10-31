// Runner uji beban memanggil aplikasi lewat nama layanan Docker (Host: app:4317). Penjaga Host tidak boleh menolaknya, tetapi tetap menjaga rute lain.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, login, type Harness } from './helpers.js';

const SECRET = 'rahasia-runner-uji-yang-cukup-panjang-123';
let h: Harness;
beforeAll(async () => { h = await harness({ LOADGEN_SECRET: SECRET }); await login(h); });
afterAll(async () => { await h.close(); });

const call = (url: string, host: string, auth?: string) => h.app.inject({
  method: 'POST', url, headers: { host, 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, payload: { k6: 'k6 v0.54', cpus: 1, version: '1.0.0' }
});

describe('penjaga Host dan runner', () => {
  it('runner dengan Host app:4317 diterima bila bearer benar, ditolak 401 (bukan 403 Host) bila salah', async () => {
    const ok = await call('/loadgen/v1/next?wait=0', 'app:4317', SECRET); expect(ok.statusCode).toBe(200); expect(ok.json()).toEqual({ job: null });
    expect((await call('/loadgen/v1/next?wait=0', 'app:4317', 'salah')).statusCode).toBe(401); expect((await call('/loadgen/v1/next?wait=0', 'app:4317')).statusCode).toBe(401);
  });
  it('rute lain tetap menolak Host yang tidak terdaftar, termasuk "app"', async () => {
    for (const host of ['app:4317', 'penyerang.example']) {
      for (const url of ['/api/me', '/api/login', '/agent/v1/heartbeat']) expect((await call(url, host)).statusCode, `${host} ${url}`).toBe(403);
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/me', headers: { host: 'localhost' } })).statusCode).toBe(401);   // Host terdaftar lolos penjaga Host; ditolak karena belum masuk
  });
  it('awalan mesin tidak bisa dipalsukan lewat jalur lain (mis. /api/loadgen/v1/ atau //loadgen/v1/)', async () => {
    expect((await call('/api/loadgen/v1/next', 'penyerang.example', SECRET)).statusCode).toBe(403);
  });
});

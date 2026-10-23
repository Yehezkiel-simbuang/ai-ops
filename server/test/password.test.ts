import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Auth from '../src/auth.js';
import { harness, type Harness } from './helpers.js';

const cookieOf = (r: { headers: Record<string, any> }) => String(r.headers['set-cookie']).split(';')[0]!;

describe('password awal 123456 dan wajib ganti', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness({ ADMIN_PASSWORD: '' }); });   // tanpa ADMIN_PASSWORD -> password bawaan
  afterAll(async () => { await h.close(); });

  it('admin awal masuk dengan 123456 dan ditandai wajib ganti', async () => {
    const r = await h.call('POST', '/api/login', { username: 'admin', password: '123456' }, { cookie: null });
    expect(r.status).toBe(200); expect(r.json.user).toMatchObject({ username: 'admin', mustChange: true });
    h.cookie = cookieOf(r);
    expect((await h.db.one<{ must_change: boolean }>('SELECT must_change FROM users WHERE username=$1', ['admin']))!.must_change).toBe(true);
  });
  it('sebelum diganti, semua API ditolak kecuali profil, keluar, dan ganti password', async () => {
    for (const [m, u] of [['GET', '/api/servers'], ['GET', '/api/overview'], ['GET', '/api/vault'], ['GET', '/api/settings'], ['POST', '/api/servers'], ['GET', '/api/audit']] as const) {
      const r = await h.call(m, u, m === 'POST' ? {} : undefined); expect(r.status, `${m} ${u}`).toBe(403); expect(r.json.code).toBe('password_change_required');
    }
    expect((await h.call('GET', '/api/me')).json.user).toMatchObject({ mustChange: true });
  });
  it('password baru yang lemah ditolak: pendek, sama dengan lama, sama dengan bawaan, sama dengan nama pengguna, atau password lama salah', async () => {
    const bad = async (current: string, next: string) => (await h.call('POST', '/api/account/password', { current, next })).status;
    expect(await bad('123456', 'pendek')).toBe(400);
    expect(await bad('123456', '123456')).toBe(400);
    expect(await bad('salah-sekali', 'password-baru-yang-panjang')).toBe(400);
    expect((await h.call('GET', '/api/me')).json.user.mustChange).toBe(true);   // belum ada yang berubah
  });
  it('ganti password: sesi lama dicabut, 123456 tak berlaku lagi, kewajiban dilepas, API terbuka', async () => {
    const oldCookie = h.cookie;
    const ok = await h.call('POST', '/api/account/password', { current: '123456', next: 'password-baru-yang-panjang' }); expect(ok.status).toBe(200);
    expect((await h.call('GET', '/api/me', undefined, { cookie: oldCookie })).status).toBe(401);   // sesi lama dicabut
    expect((await h.call('POST', '/api/login', { username: 'admin', password: '123456' }, { cookie: null })).status).toBe(401);
    const r = await h.call('POST', '/api/login', { username: 'admin', password: 'password-baru-yang-panjang' }, { cookie: null });
    expect(r.status).toBe(200); expect(r.json.user.mustChange).toBe(false); h.cookie = cookieOf(r);
    expect((await h.call('GET', '/api/servers')).status).toBe(200);
    expect((await h.call('GET', '/api/audit')).json.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['password.ganti']));
  });
  it('pemulihan mengembalikan 123456 dan kewajiban ganti, dan mencabut semua sesi; pengguna yang tidak ada ditolak', async () => {
    expect(await Auth.resetPassword('admin')).toBe(true);
    expect((await h.call('GET', '/api/servers')).status).toBe(401);   // sesi dicabut
    const r = await h.call('POST', '/api/login', { username: 'admin', password: '123456' }, { cookie: null }); expect(r.status).toBe(200); expect(r.json.user.mustChange).toBe(true);
    expect(await Auth.resetPassword('tidak-ada')).toBe(false);
  });
});

describe('password pilihan operator tidak dipaksa ganti', () => {
  it('ADMIN_PASSWORD disetel: tanpa kewajiban ganti', async () => {
    const h = await harness();
    try {
      const r = await h.call('POST', '/api/login', { username: 'admin', password: 'password-uji-12345' }, { cookie: null });
      expect(r.status).toBe(200); expect(r.json.user.mustChange).toBe(false);
      h.cookie = cookieOf(r); expect((await h.call('GET', '/api/servers')).status).toBe(200);
    } finally { await h.close(); }
  });
});

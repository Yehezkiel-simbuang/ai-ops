// Katalog templat Setup: bentuknya konsisten, aturan keselamatan ikut di setiap templat pemasangan, dan bagian [ISI: ...] wajib diganti.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATEGORIES, PLACEHOLDER, TEMPLATES } from '../src/templates.js';
import { RULES, SETUP_TEMPLATES } from '../src/templates-setup.js';
import { harness, login, type Harness } from './helpers.js';

let h: Harness, sid = 0;
beforeAll(async () => { h = await harness({}); await login(h); sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-setup', host: '10.5.5.5', username: 'ops' })).json.id; });
afterAll(async () => { await h.close(); });

const holes = (goal: string): string[] => goal.match(new RegExp(PLACEHOLDER.source, 'g')) ?? [];

describe('katalog templat', () => {
  it('id unik, kategori dikenal, dan urutan mengikuti kelompok', () => {
    const ids = TEMPLATES.map((t) => t.id); expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) expect(CATEGORIES, t.id).toContain(t.category);
    const order = TEMPLATES.map((t) => CATEGORIES.indexOf(t.category as never)); expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(ids).toEqual(expect.arrayContaining(['baseline', 'docker-install', 'node-app', 'react-static', 'go-service', 'laravel', 'postgres-install', 'mysql-install', 'redis-install', 'rabbitmq-install', 'qdrant-install', 'lb-nginx', 'lb-haproxy', 'nginx-tls']));
    expect(TEMPLATES.find((t) => t.id === 'netdata')!.category).toBe('Fondasi server'); expect(TEMPLATES.find((t) => t.id === 'diagnosis')!.category).toBe('Diagnosis dan tuning');
  });

  it('setiap templat punya tujuan, minimal lima langkah, dan nama', () => {
    for (const t of TEMPLATES) { expect(t.name.length, t.id).toBeGreaterThan(5); expect(t.goal.length, t.id).toBeGreaterThan(80); expect(t.steps.length, t.id).toBeGreaterThanOrEqual(5); for (const s of t.steps) expect(s.trim().length, t.id).toBeGreaterThan(5); }
  });

  it('templat pemasangan membawa aturan keselamatan; hal yang harus diisi sesuai dengan bagian [ISI: ...]', () => {
    for (const t of SETUP_TEMPLATES) {
      expect(t.goal, t.id).toContain(RULES); expect(t.goal, t.id).toMatch(/jangan curl\|sh/);
      expect(t.maxTurns, t.id).toBeGreaterThanOrEqual(30); expect(t.tokenBudget, t.id).toBeGreaterThanOrEqual(200_000);
      expect(holes(t.goal).length, `${t.id}: tiap bagian [ISI] punya keterangan di ask`).toBe(t.ask?.length ?? 0);
      expect(holes(t.goal).length, `${t.id}: tiap templat pemasangan meminta nilai dari pengguna`).toBeGreaterThan(0);
    }
  });

  it('tidak ada templat yang menyuruh sesuatu yang berbahaya: skrip yang langsung dijalankan, izin 777, layanan data terbuka ke semua alamat, atau kata sandi di perintah', () => {
    for (const t of SETUP_TEMPLATES) {
      const goal = t.goal.replace(RULES, ''), all = `${goal} ${t.steps.join(' ')}`.replace(/(jangan|bukan)\s+curl\|sh/gi, '');   // kalimat larangannya sendiri bukan pelanggaran
      expect(all, t.id).not.toMatch(/curl[^.]*\|\s*(ba)?sh|wget[^.]*\|\s*(ba)?sh/i); expect(all, t.id).not.toMatch(/chmod\s+(-R\s+)?777|\b0\.0\.0\.0\b/); expect(all, t.id).not.toMatch(/--password|s-pS{6,}/);
    }
    for (const id of ['postgres-install', 'mysql-install', 'redis-install', 'rabbitmq-install', 'qdrant-install']) expect(SETUP_TEMPLATES.find((t) => t.id === id)!.goal, id).toMatch(/mode 600/);   // sandi acak, disimpan di berkas terbatas
    expect(SETUP_TEMPLATES.find((t) => t.id === 'baseline')!.goal).toMatch(/reload, bukan restart/);   // pengerasan SSH tidak memutus akses
  });

  it('API templat mengembalikan kategori, ask, dan anggaran yang disarankan', async () => {
    const t = (await h.call('GET', '/api/templates')).json as Array<Record<string, any>>, pg = t.find((x) => x.id === 'postgres-install')!;
    expect(pg).toMatchObject({ category: 'Data dan antrean', maxTurns: 40, tokenBudget: 300000 }); expect(pg.ask).toEqual(['Nama database', 'Pengguna aplikasi', 'Alamat klien']); expect(t.find((x) => x.id === 'diagnosis')).toMatchObject({ category: 'Diagnosis dan tuning' });
  });
});

describe('membuat proses dari templat pemasangan', () => {
  it('tujuan yang masih berisi [ISI: ...] ditolak dan menyebut bagian yang belum diisi; yang sudah diganti diterima', async () => {
    const t = TEMPLATES.find((x) => x.id === 'postgres-install')!, body = { serverId: sid, template: t.id, goal: t.goal };
    const bad = await h.call('POST', '/api/runs', body); expect(bad.status).toBe(400); expect(bad.json.error).toMatch(/masih berisi bagian yang harus Anda isi: \[ISI: nama\]/);
    const filled = t.goal.split(PLACEHOLDER.source).length && t.goal.replace(new RegExp(PLACEHOLDER.source, 'g'), 'appdb');
    const ok = await h.call('POST', '/api/runs', { ...body, goal: filled }); expect(ok.status).toBe(200);
    const run = (await h.call('GET', `/api/runs/${ok.json.id}`)).json.run; expect(run.steps).toHaveLength(t.steps.length); expect(run.goal).toContain('appdb'); expect(run.goal).toContain(RULES.slice(0, 40));
  });
  it('templat diagnosis lama tetap bisa dipakai tanpa mengisi apa pun', async () => {
    const t = TEMPLATES.find((x) => x.id === 'diagnosis')!; expect(holes(t.goal)).toEqual([]);
    expect((await h.call('POST', '/api/runs', { serverId: sid, template: t.id })).status).toBe(200);
  });
});

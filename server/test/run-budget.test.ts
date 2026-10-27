// Anggaran run: bisa ditambah (juga saat run berhenti karena habis), dibatasi, dan run yang anggarannya habis tidak bisa dimulai lagi tanpa tambahan.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/context.js';
import { harness, login, type Harness } from './helpers.js';

let h: Harness, sid = 0;
beforeAll(async () => { h = await harness({}); await login(h); sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-anggaran', host: '10.6.6.6', username: 'ops' })).json.id; });
afterAll(async () => { await h.close(); });

const newRun = async (maxTurns: number, tokenBudget: number) => (await h.call('POST', '/api/runs', { serverId: sid, name: 'uji anggaran', goal: 'tujuan', maxTurns, tokenBudget })).json.id as string;

describe('anggaran run', () => {
  it('menambah giliran dan token, dan tidak melewati batas atas', async () => {
    const id = await newRun(30, 200000);
    const r = await h.call('POST', `/api/runs/${id}/budget`, { addTurns: 20, addTokens: 150000 });
    expect(r.status).toBe(200); expect(r.json.max_turns).toBe(50); expect(r.json.token_budget).toBe(350000);
    const big = await h.call('POST', `/api/runs/${id}/budget`, { addTurns: 200, addTokens: 5_000_000 });
    expect(big.json.max_turns).toBe(200); expect(big.json.token_budget).toBe(5_000_000);
  });

  it('menolak tambahan kosong atau negatif, dan run yang tidak ada', async () => {
    const id = await newRun(30, 200000);
    expect((await h.call('POST', `/api/runs/${id}/budget`, {})).status).toBe(400);
    expect((await h.call('POST', `/api/runs/${id}/budget`, { addTurns: -1 })).status).toBe(400);
    expect((await h.call('POST', '/api/runs/tidak-ada/budget', { addTurns: 5 })).status).toBe(400);
  });

  it('run yang anggarannya habis ditolak saat dimulai, dan bisa dimulai setelah ditambah', async () => {
    const id = await newRun(30, 200000);
    await db().exec('UPDATE runs SET turns=30 WHERE id=$1', [id]);
    const blocked = await h.call('POST', `/api/runs/${id}/start`);
    expect(blocked.status).toBe(400); expect(blocked.json.error).toMatch(/Anggaran run sudah habis/);
    await h.call('POST', `/api/runs/${id}/budget`, { addTurns: 20 });
    expect((await db().one('SELECT max_turns FROM runs WHERE id=$1', [id]))!.max_turns).toBe(50);
  });
});

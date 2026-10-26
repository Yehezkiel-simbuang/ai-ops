import { describe, expect, it } from 'vitest';
import { totalRps } from './scenario';
import type { LabEstimate, LabLoad, LabWorkload } from './types';
import { cpuEstimateOf, currentRates, userWorkloads, withCpuMs, withRate } from './workloads';

const spike = { on: false, mult: 4, at: 15, len: 45, every: 0, shape: 'step' } as const;
const workloads: LabWorkload[] = [
  { id: 'read', client: 'users', rate: 30, cpuMs: 8 }, { id: 'write', client: 'users', rate: 6, cpuMs: 12 },
  { id: 'jobs', client: 'w', rate: 3, async: true }, { id: 'mailq', client: 'users', rate: 1, async: true, mixed: true }
];
// 36 req/dtk dari pengguna (30 + 6), antrean campuran 1 req/dtk -> total 37
const load: LabLoad = { users: 370, rpu: 6, mix: { read: 81.08, write: 16.22, mailq: 2.7 }, spike };

describe('laju per workload', () => {
  it('hanya workload yang dipicu pengguna ikut campuran (sinkron dan antrean campuran)', () => {
    expect(userWorkloads(workloads).map((w) => w.id)).toEqual(['read', 'write', 'mailq']);
  });
  it('laju dibaca dari total beban dan campuran', () => {
    const r = currentRates(load, workloads);
    expect(r.read).toBeCloseTo(30, 1); expect(r.write).toBeCloseTo(6, 1); expect(r.mailq).toBeCloseTo(1, 1); expect(r.jobs).toBeUndefined();
  });
  it('mengganti laju satu workload menghitung ulang total dan campuran; yang lain tetap', () => {
    const next = withRate(load, workloads, 'read', 60), r = currentRates(next, workloads);
    expect(r.read).toBeCloseTo(60, 1); expect(r.write).toBeCloseTo(6, 1); expect(r.mailq).toBeCloseTo(1, 1);
    expect(totalRps(next)).toBeCloseTo(67, 1);
    expect(Object.values(next.mix).reduce((s, v) => s + v, 0)).toBeGreaterThan(99.9);
  });
  it('request per menit per pengguna dipertahankan sedekat mungkin dan tetap dalam batas', () => {
    const next = withRate(load, workloads, 'read', 0.5);
    expect(next.rpu).toBeGreaterThanOrEqual(0.1); expect(next.rpu).toBeLessThanOrEqual(600); expect(next.users).toBeGreaterThanOrEqual(1);
    expect(totalRps(next)).toBeCloseTo(7.5, 1);
  });
  it('total nol tidak diterima: beban tetap', () => {
    const only: LabWorkload[] = [{ id: 'a', client: 'u', rate: 1 }], l: LabLoad = { users: 10, rpu: 6, mix: { a: 100 }, spike };
    expect(withRate(l, only, 'a', 0)).toBe(l);
  });
  it('mengembalikan ke laju awal memberi beban yang setara', () => {
    const edited = withRate(load, workloads, 'read', 90), back = withRate(edited, workloads, 'read', 30), r = currentRates(back, workloads);
    expect(r.read).toBeCloseTo(30, 1); expect(totalRps(back)).toBeCloseTo(totalRps(load), 1);
  });
});

describe('waktu CPU per workload', () => {
  it('menambah, mengganti, dan menghapus estimasi workload tanpa menyentuh estimasi node', () => {
    const node: LabEstimate = { node: 'api', key: 'workers', value: 20 };
    const a = withCpuMs([node], 'read', 14), b = withCpuMs(a, 'read', 20), c = withCpuMs(b, 'read', null);
    expect(a).toEqual([node, { node: 'read', key: 'cpuMs', value: 14, scope: 'workload' }]);
    expect(cpuEstimateOf(b, 'read')?.value).toBe(20); expect(b.filter((e) => e.node === 'read')).toHaveLength(1);
    expect(c).toEqual([node]);
  });
  it('estimasi node dengan id sama tidak dianggap estimasi workload', () => {
    expect(cpuEstimateOf([{ node: 'read', key: 'cpuMs', value: 3 }], 'read')).toBeUndefined();
  });
});

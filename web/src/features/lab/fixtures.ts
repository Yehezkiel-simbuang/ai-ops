// Data contoh untuk tes lab.
import type { LabComponent, LabFrame, LabLoad, LabProject, LabRun, LabSummary } from './types';

export const load: LabLoad = { users: 500, rpu: 6, mix: { browse: 95, report: 5 }, spike: { on: false, mult: 4, at: 15, len: 45, every: 0, shape: 'step' } };

export const catalog: LabComponent[] = [
  { id: 'redis', label: 'Cache Redis', icon: 'cache', summary: 'Query baca disimpan di Redis.', assumptions: 'Hit ratio ditetapkan.', available: true, reason: null,
    params: [{ key: 'hit', label: 'Hit ratio', type: 'number', min: 50, max: 99, step: 1, default: 85, unit: '%' }] },
  { id: 'replica', label: 'Replika baca database', icon: 'replica', summary: 'Salinan khusus baca.', assumptions: 'Tanpa lag.', available: true, reason: null,
    params: [{ key: 'db', label: 'Database', type: 'select', default: 'pg', options: [{ value: 'pg', label: 'Postgres' }, { value: 'pg2', label: 'Postgres 2' }] }, { key: 'share', label: 'Porsi baca ke replika', type: 'number', min: 30, max: 95, step: 1, default: 80, unit: '%' }] },
  { id: 'ssd', label: 'Pindah ke SSD NVMe', icon: 'disk', summary: 'Disk lebih cepat.', assumptions: 'NVMe tipikal.', available: false, reason: 'Disk sudah secepat SSD NVMe.', params: [] }
];

export const project: LabProject = {
  id: 'contoh', name: 'Contoh', source: 'contoh', stack: ['Contoh'], arch: { nodes: [], workloads: [] }, recs: [
    { id: 'split-api', title: 'Pisahkan pool untuk request berat', severity: 'tinggi', optional: false, why: ['laporan menahan worker'], tradeoff: 'Butuh RAM.', expected: 'Request lain tidak antre.' },
    { id: 'flush2', title: 'Kurangi fsync', severity: 'sedang', optional: true, why: [], tradeoff: '', expected: '' }
  ], recommendedIds: ['split-api'], faults: [{ name: 'Disk tersendat' }], faultsAssumed: true, seconds: 120, load, catalog
};

const frame = (t: number, over: Partial<LabFrame> = {}): LabFrame => ({ t, offered: 40, ok: 40, e504: 0, eConn: 0, p95: 0.1, nodes: {}, flows: {}, diag: 0, ...over });

export const summary = (over: Partial<LabSummary> = {}): LabSummary => ({ seconds: 100, fastPct: 99, okPct: 100, e504: 0, eConn: 0, p50: 0.05, p95: 0.2, throughput: 40, worstNode: 'api', per: {}, outageSeconds: 0, degradedSeconds: 0, ha: [], ...over });

/** Arsitektur kecil: pengguna -> gateway -> api -> pg -> ssd. */
export const run = (over: Partial<LabRun> = {}, frameOver: Partial<LabFrame> = {}): LabRun => ({
  failure: null, arch: {
    nodes: [
      { id: 'users', type: 'client', label: 'Pengguna' }, { id: 'gw', type: 'proxy', label: 'Gateway' }, { id: 'api', type: 'pool', label: 'Server API', workers: 20 },
      { id: 'pg', type: 'db', label: 'Postgres' }, { id: 'ssd', type: 'disk', label: 'SSD' }
    ], workloads: []
  },
  edges: [['users', 'gw'], ['gw', 'api'], ['api', 'pg'], ['pg', 'ssd']],
  frames: [frame(1, {
    nodes: { api: { u: 0.3, busy: 6, cap: 20, q: 0 }, pg: { u: 0.7, busy: 35, cap: 50, q: 0 }, ssd: { u: 0.95, q: 4 } },
    flows: { 'users>gw': 40, 'gw>api': 40, 'api>pg': 38, 'pg>ssd': 9 }, ...frameOver
  })],
  diags: [{ node: null, lv: 0, title: 'Sehat', text: 'Semua punya ruang.' }, { node: 'ssd', lv: 2, title: 'Bottleneck: SSD (fsync) menahan commit', text: 'Percepat penyimpanan.' }],
  nodes: {}, summary: summary(), ...over
});

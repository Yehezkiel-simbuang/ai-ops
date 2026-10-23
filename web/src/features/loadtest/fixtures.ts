import type { Analysis, LoadTest, LoadTestDetail, LoadTestListItem, LoadTestStatus, StageResult } from './types';

export const status: LoadTestStatus = { enabled: true, allowedHosts: ['staging.contoh.com'], runner: { online: true, lastSeen: Date.now(), info: { k6: 'k6 v0.54.0', cpus: 1, version: '1.0.0' } } };

export const test = (over: Partial<LoadTest> = {}): LoadTest => ({
  id: 5, name: 'Proyek A', target: 'http://10.0.0.5:8080', allow_public: false, status: 'draft', cancel_requested: false, error: '', approved_by: '',
  scenario: { requests: [{ name: 'produk', method: 'GET', path: '/produk', weight: 8 }, { name: 'checkout', method: 'POST', path: '/checkout', weight: 1, body: '{"a":1}' }], thinkSeconds: 1, headerNames: [] },
  stages: [{ vus: 5, seconds: 10 }, { vus: 20, seconds: 10 }, { vus: 80, seconds: 10 }], criteria: { p95Ms: 500, errPct: 1 }, scrape: [], runner: null,
  created: Date.now() - 60_000, started: null, finished: null, heartbeat: null, ...over
});

export const stage = (idx: number, vus: number, rps: number, p95: number, over: Partial<StageResult> = {}): StageResult => ({
  idx, vus, seconds: 10, reqs: rps * 10, rps, p50: p95 / 3, p95, p99: p95 * 1.4, errPct: 0, genCpu: 0.1, valid: true, scraped: {}, ...over
});

const none: Analysis = { healthy: null, knee: null, plateau: null, invalidStages: [], verdict: { tone: 'mute', title: 'Belum ada hasil', text: '' } };
const withKnee: Analysis = {
  healthy: { idx: 1, vus: 20, rps: 17 }, knee: { idx: 2, vus: 80, rps: 40, reason: 'p95 900 ms melebihi batas 500 ms' }, plateau: null, invalidStages: [],
  verdict: { tone: 'warn', title: 'Sehat sampai 20 pengguna (≈ 17.0 req/dtk), mulai tidak sehat di 80', text: 'Tahap 3: p95 900 ms melebihi batas 500 ms.' }
};

export const draft = (): LoadTestDetail => { const { stages, ...t } = test(); return { ...t, plan: stages, stages: [], analysis: none }; };
export const finished = (): LoadTestDetail => {
  const { stages, ...t } = test({ status: 'done', approved_by: 'admin', started: Date.now() - 50_000, finished: Date.now() - 10_000, scrape: [{ label: 'pool', url: 'http://10.0.0.5:8080/metrics', metric: 'pool_in_use' }], runner: { k6: 'k6 v0.54.0', cpus: 1, version: '1.0.0' } });
  return {
    ...t, plan: stages, analysis: withKnee,
    stages: [stage(0, 5, 4.5, 80, { scraped: { pool: { avg: 1, max: 2, last: 1 } } }), stage(1, 20, 17, 200, { scraped: { pool: { avg: 2, max: 4, last: 3 } } }), stage(2, 80, 40, 900, { genCpu: 0.9, valid: false, scraped: { pool: { avg: 7, max: 8, last: 8 } } })]
  };
};
export const running = (): LoadTestDetail => { const f = finished(); return { ...f, status: 'running', finished: null, stages: f.stages.slice(0, 1), analysis: none }; };
export const listItem = (over: Partial<LoadTest> = {}, stageCount = 0, analysis: Analysis = none): LoadTestListItem => ({ ...test(over), stageCount, analysis });

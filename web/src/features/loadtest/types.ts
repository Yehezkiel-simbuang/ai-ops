// Bentuk data uji beban dari backend (/api/loadtests).
export type TestStatus = 'draft' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface LoadRequest { name: string; method: Method; path: string; weight: number; body?: string }
export interface LoadStage { vus: number; seconds: number }
export interface LoadScrape { label: string; url: string; metric: string }
export interface LoadCriteria { p95Ms: number; errPct: number }

export interface LoadTest {
  id: number; name: string; target: string; allow_public: boolean; status: TestStatus; cancel_requested: boolean; error: string; approved_by: string;
  scenario: { requests: LoadRequest[]; thinkSeconds: number; headerNames: string[] }; stages: LoadStage[]; criteria: LoadCriteria; scrape: LoadScrape[];
  setup?: { name: string } | null; runner: { k6: string; cpus: number; version: string } | null; created: number; started: number | null; finished: number | null; heartbeat: number | null;
}

export interface StageResult {
  idx: number; vus: number; seconds: number; reqs: number; rps: number; p50: number; p95: number; p99: number; errPct: number; genCpu: number; valid: boolean;
  scraped: Record<string, { avg: number; max: number; last: number }>;
}
export interface Analysis {
  healthy: { idx: number; vus: number; rps: number } | null; knee: { idx: number; vus: number; rps: number; reason: string } | null; plateau: { fromVus: number; rps: number } | null;
  invalidStages: number[]; verdict: { tone: 'ok' | 'warn' | 'bad' | 'mute'; title: string; text: string };
}
export type LoadTestListItem = LoadTest & { stageCount: number; analysis: Analysis };
/** Detail: `plan` = rencana tahap; `stages` = hasil yang sudah dilaporkan runner. */
/** Penjelasan AI dikerjakan di server dan disimpan; null = belum pernah diminta. */
export interface AiExplanation { status: 'running' | 'done' | 'failed'; text: string; model: string; error: string; ts: number | null }
export type LoadTestDetail = Omit<LoadTest, 'stages'> & { plan: LoadStage[]; stages: StageResult[]; analysis: Analysis; ai: AiExplanation | null };

export interface LoadTestStatus { enabled: boolean; allowedHosts: string[]; runner: { online: boolean; lastSeen: number | null; info: { k6: string; cpus: number; version: string } | null } }

export interface NewLoadTest {
  name: string; target: string; confirmNotProduction: true; requests: LoadRequest[]; thinkSeconds: number; headers: Record<string, string>;
  stages: LoadStage[]; criteria: LoadCriteria; scrape: LoadScrape[]; playgroundId?: number;
}

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
/** Arsitektur susunan yang diuji dan analisis bottleneck (hanya ada di detail satu uji). */
export type Role = 'proxy' | 'app' | 'db' | 'cache' | 'queue' | 'vector' | 'search';
export interface ArchNode { name: string; image: string; role: Role; entry: boolean }
export interface ArchEdge { from: string; to: string; label: string }
export interface Placement { a: Role; b: Role; relation: 'sama' | 'beda' | 'bebas'; why: string; condition?: string }
export interface ServerBox { id: string; label: string; note: string; nodes: Array<Pick<ArchNode, 'name' | 'image' | 'role'>> }
export interface Architecture { nodes: ArchNode[]; edges: ArchEdge[]; placements: Placement[]; current: ServerBox[]; advised: ServerBox[]; changed: boolean; notes: string[] }
export type Confidence = 'terukur' | 'kuat' | 'dugaan';
export interface Finding { component: string; role: Role | 'host' | 'generator' | 'tidak diketahui'; confidence: Confidence; title: string; evidence: string[]; advice: string[]; score: number }
export interface UsageRow { service: string; role: Role | 'host'; stages: Array<{ idx: number; vus: number; cpu: number | null; mem: number | null }> }
export interface BottleneckReport { basis: 'terukur' | 'perkiraan'; stageIdx: number | null; headline: string; findings: Finding[]; usage: UsageRow[]; cautions: string[] }
/** Keadaan terbaru selama uji berjalan: pemakaian sampel terakhir tiap komponen (0..1+ terhadap kapasitasnya) dan tahap yang sedang jalan. Null bila belum ada sampel atau uji tidak berjalan. */
export interface LiveService { service: string; role: Role | 'host'; cpuCores: number; cpu: number | null; memMb: number; mem: number | null }
export interface Live { at: number; stageIdx: number; vus: number | null; maxVus: number; services: LiveService[]; host: { cores: number; load: number; cpu: number; mem: number | null } | null }
export type LoadTestDetail = Omit<LoadTest, 'stages'> & { plan: LoadStage[]; stages: StageResult[]; analysis: Analysis; ai: AiExplanation | null; architecture?: Architecture | null; bottleneck?: BottleneckReport; live?: Live | null };

export interface LoadTestStatus { enabled: boolean; allowedHosts: string[]; runner: { online: boolean; lastSeen: number | null; info: { k6: string; cpus: number; version: string } | null } }

export interface NewLoadTest {
  name: string; target: string; confirmNotProduction: true; requests: LoadRequest[]; thinkSeconds: number; headers: Record<string, string>;
  stages: LoadStage[]; criteria: LoadCriteria; scrape: LoadScrape[]; playgroundId?: number;
}

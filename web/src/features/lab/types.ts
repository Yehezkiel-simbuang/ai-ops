// Bentuk data lab dari backend (/api/lab/*).
export type ParamValue = number | string | boolean;

export interface LabNode { id: string; type: 'client' | 'proxy' | 'pool' | 'cache' | 'db' | 'disk' | 'external'; label?: string; workers?: number; cores?: number; connections?: number; instances?: number; disk?: string; assumed?: string[] }
export interface LabWorkload { id: string; label?: string; client: string; pool?: string; rate: number; async?: boolean; cdn?: number }
export interface LabArch { name?: string; nodes: LabNode[]; workloads: LabWorkload[] }

export interface LabParam {
  key: string; label: string; type: 'number' | 'select' | 'bool'; default: ParamValue;
  min?: number; max?: number; step?: number; unit?: string; options?: Array<{ value: string; label: string }>;
}
export type ComponentId = 'redis' | 'lb' | 'filter' | 'replica' | 'hadb' | 'dbsplit' | 'queue' | 'scaleup' | 'ssd' | 'cdn';
export interface LabComponent { id: ComponentId; label: string; icon: string; summary: string; assumptions: string; available: boolean; reason: string | null; params: LabParam[] }

export interface LabRec { id: string; title: string; severity: 'tinggi' | 'sedang' | 'rendah'; optional: boolean; why: string[]; tradeoff: string; expected: string }
export interface LabSpike { on: boolean; mult: number; at: number; len: number; every: number; shape: 'step' | 'tri' }
export interface LabLoad { users: number; rpu: number; mix: Record<string, number>; spike: LabSpike }

export interface LabProjectSummary { id: string; name: string; source: 'contoh' | 'folder'; stack: string[] }
export interface LabProject extends LabProjectSummary {
  arch: LabArch; recs: LabRec[]; recommendedIds: string[]; faults: Array<{ name: string }>; faultsAssumed: boolean; seconds: number; load: LabLoad; catalog: LabComponent[];
}

export type LabAction = { kind: 'rec'; id: string } | { kind: 'component'; component: ComponentId; params: Record<string, ParamValue> };
/** Skenario kegagalan: matikan satu node pada detik `at` selama `len` detik (0 = sampai akhir). */
export interface LabFailure { node: string; at: number; len: number }
export interface LabEstimate { node: string; key: string; value: number }
export interface LabEstimateResult {
  estimates: Array<LabEstimate & { current: unknown; confidence: 'tinggi' | 'sedang' | 'rendah'; verified: boolean; file: string; line: number; quote: string; reason: string }>;
  role: string; model: string; filesRead: string[]; assumedCount: number;
}
export interface Scenario { project: string; actions: LabAction[]; estimates?: LabEstimate[]; load: LabLoad; seconds: number; faults: boolean; failure: LabFailure | null }

export interface NodeLoad { u: number; busy?: number; cap?: number; q?: number; lock?: number; commit?: number; stalled?: boolean }
export interface LabFrame { t: number; offered: number; ok: number; e504: number; eConn: number; p95: number; nodes: Record<string, NodeLoad>; flows: Record<string, number>; diag: number; states?: Record<string, NodeState> }
export type NodeState = 'down' | 'failover' | 'degraded' | 'warm'
export interface LabDiag { node: string | null; lv: 0 | 1 | 2; title: string; text: string }
export interface LabSummary {
  seconds: number; fastPct: number; okPct: number; e504: number; eConn: number; p50: number; p95: number; throughput: number; worstNode: string | null;
  outageSeconds: number; degradedSeconds: number; ha: Array<{ db: string; failoverS: number; sync: boolean; lagMs: number; writesPerSec: number; rpoTx: number }>;
  per: Record<string, { label?: string; okPct: number; fastPct: number; p95: number; e504: number }>;
}
export interface LabRun { failure: { node: string; label: string; at: number; len: number; skipped: string | null } | null; arch: LabArch; edges: Array<[string, string]>; frames: LabFrame[]; diags: LabDiag[]; nodes: Record<string, { avgU: number; maxU: number; maxQ: number }>; summary: LabSummary }
export interface LabResult { applied: Array<{ kind: string; id?: string; title?: string; component?: string; key?: string }>; skipped: Array<{ reason: string }>; baseline: LabRun; experiment: LabRun }

export interface LabDesign { id: number; project: string; name: string; actions: LabAction[]; load: LabLoad; faults: boolean; seconds: number; failure: LabFailure | null; updated: number }

export interface BottleneckRank { node: string; label: string; count: number; share: number; medianMultiple: number; title: string; text: string }
export interface BottleneckAnalysis { ranking: BottleneckRank[]; variations: number; planned: number; multiples: number[]; complete: boolean; healthyCount: number; cappedCount: number; varied: string[]; ms: number }
export interface LabBottlenecks { baseline: BottleneckAnalysis; experiment: BottleneckAnalysis }

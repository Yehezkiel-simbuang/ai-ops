// Bentuk data lab di sisi server. Hasil simulasi (bingkai, arsitektur) diteruskan apa adanya dari worker.
import { z } from 'zod';

export const COMPONENT_IDS = ['redis', 'lb', 'filter', 'replica', 'hadb', 'dbsplit', 'queue', 'scaleup', 'ssd', 'cdn'] as const;

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rec'), id: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('component'), component: z.enum(COMPONENT_IDS), params: z.record(z.string().max(40), z.union([z.number(), z.string().max(80), z.boolean()])).default({}) })
]);
export type LabAction = z.infer<typeof actionSchema>;

const spikeSchema = z.object({
  on: z.boolean(), mult: z.number().min(1).max(10), at: z.number().min(0).max(300), len: z.number().min(1).max(300), every: z.number().min(0).max(300), shape: z.enum(['step', 'tri'])
});
/** Estimasi yang diterima pengguna. scope 'node' (bawaan): mengganti parameter tebakan pada satu node; hanya kunci yang ditandai tebakan yang diterapkan.
 *  scope 'workload': `node` berisi id workload dan hanya `cpuMs` (waktu CPU per request) yang boleh diganti; laju diatur lewat beban (mix), bukan di sini. */
export const WORKLOAD_KEYS = ['cpuMs'] as const;
export const estimateSchema = z.object({ node: z.string().min(1).max(80), key: z.string().min(1).max(40), value: z.number().positive().max(1_000_000), scope: z.enum(['node', 'workload']).default('node') })
  .refine((e) => e.scope === 'node' || (WORKLOAD_KEYS as readonly string[]).includes(e.key), { message: 'Workload hanya boleh mengganti cpuMs', path: ['key'] });
export type LabEstimate = z.infer<typeof estimateSchema>;

export const loadSchema = z.object({
  users: z.number().min(1).max(200_000), rpu: z.number().min(0.1).max(600), mix: z.record(z.string().max(80), z.number().min(0).max(100)), spike: spikeSchema
});
export type LabLoad = z.infer<typeof loadSchema>;

/** Skenario kegagalan: matikan satu node pada detik `at` selama `len` detik (0 = sampai akhir simulasi). */
export const failureSchema = z.object({ node: z.string().min(1).max(80), at: z.number().min(0).max(299), len: z.number().min(0).max(300) });
export type LabFailure = z.infer<typeof failureSchema>;

/** Batas beban: simulasi dijalankan per request, jadi puncak yang terlalu besar akan terlalu lama. */
export const MAX_PEAK_RPS = 4000;
export const peakRps = (l: LabLoad): number => (l.users * l.rpu / 60) * (l.spike.on ? l.spike.mult : 1);

export const simulateSchema = z.object({
  project: z.string().min(1).max(120),
  actions: z.array(actionSchema).max(20).default([]),
  estimates: z.array(estimateSchema).max(40).default([]),
  load: loadSchema,
  seconds: z.number().int().min(30).max(300).default(120),
  faults: z.boolean().default(true),
  failure: failureSchema.nullable().default(null)
});
export type SimulateInput = z.infer<typeof simulateSchema>;

export const bottlenecksSchema = z.object({ project: z.string().min(1).max(120), actions: z.array(actionSchema).max(20).default([]), estimates: z.array(estimateSchema).max(40).default([]), load: loadSchema });
export type BottlenecksInput = z.infer<typeof bottlenecksSchema>;

export const designSchema = z.object({
  project: z.string().min(1).max(120), name: z.string().trim().min(1).max(80), actions: z.array(actionSchema).max(20), load: loadSchema,
  faults: z.boolean(), seconds: z.number().int().min(30).max(300), failure: failureSchema.nullable().default(null)
});
export type DesignInput = z.infer<typeof designSchema>;

export interface ProjectSummary { id: string; name: string; source: 'contoh' | 'folder'; stack: string[] }
export interface Recommendation { id: string; title: string; severity: string; optional: boolean; why: string[]; tradeoff: string; expected: string; patch: unknown[] }
export interface ProjectDetail extends ProjectSummary {
  arch: { nodes: unknown[]; workloads: unknown[]; observedFaults?: unknown[]; faults?: unknown[] };
  facts: { stack: string | null; kind: string | null } | null; recs: Recommendation[]; recommendedIds: string[];
  faults: Array<{ name: string; spec: Record<string, unknown> }>; faultsAssumed: boolean; seconds: number; load: unknown; catalog: unknown[];
}
export interface BottleneckRank { node: string; label: string; count: number; share: number; medianMultiple: number; title: string; text: string }
export interface BottleneckAnalysis { ranking: BottleneckRank[]; variations: number; planned: number; multiples: number[]; complete: boolean; healthyCount: number; cappedCount: number; varied: string[]; ms: number }
export interface BottlenecksResult { baseline: BottleneckAnalysis; experiment: BottleneckAnalysis }
export interface SimulateRun { failure: { node: string; label: string; at: number; len: number; skipped: string | null } | null; arch: unknown; edges: Array<[string, string]>; frames: unknown[]; diags: unknown[]; nodes: Record<string, unknown>; summary: Record<string, unknown> }
export interface SimulateResult { applied: unknown[]; skipped: unknown[]; baseline: SimulateRun; experiment: SimulateRun }

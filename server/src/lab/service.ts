// Lab arsitektur: daftar proyek (contoh + folder di PROJECTS_ROOT), detail + rekomendasi awal, dan simulasi eksperimen vs kondisi awal.
// Kerja berat dijalankan di worker thread (runner.ts); modul simulator (JS) ada di LEGACY_ROOT.
import { readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { bad, ctx } from '../context.js';
import { resolveProject } from '../plan.js';
import { LabRunner } from './runner.js';
import { MAX_PEAK_RPS, peakRps, type BottlenecksInput, type LabEstimate, type BottlenecksResult, type ProjectDetail, type ProjectSummary, type SimulateInput, type SimulateRun, type SimulateResult } from './types.js';

const PROJECT_TTL_MS = 10 * 60_000, BASELINE_CACHE_MAX = 30;
const FOLDER_ID = /^folder:([\w][\w .+\-]{0,100})$/;

let runner: LabRunner | null = null;
const projects = new Map<string, { at: number; detail: ProjectDetail }>();
const baselines = new Map<string, SimulateRun>();
const bottlenecks = new Map<string, BottlenecksResult>();

function getRunner(): LabRunner {
  if (!runner) runner = new LabRunner(resolve(ctx().cfg.LEGACY_ROOT, 'tools', 'lab-worker.js'));
  return runner;
}
export async function closeLab(): Promise<void> { const r = runner; runner = null; projects.clear(); baselines.clear(); bottlenecks.clear(); if (r) await r.close(); }

function folderRoot(): string | null {
  const root = ctx().cfg.PROJECTS_ROOT;
  if (!root) return null;
  try { return realpathSync(resolve(root)); } catch { return null; }
}

export async function listProjects(): Promise<{ projects: ProjectSummary[]; foldersEnabled: boolean }> {
  const examples = await getRunner().call<ProjectSummary[]>('listExamples');
  const root = folderRoot();
  if (!root) return { projects: examples, foldersEnabled: false };
  try { readdirSync(root); } catch { return { projects: examples, foldersEnabled: false }; }
  const folders = await getRunner().call<ProjectSummary[]>('listFolders', { root });
  return { projects: [...examples, ...folders], foldersEnabled: true };
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const hit = projects.get(id);
  if (hit && Date.now() - hit.at < PROJECT_TTL_MS) return hit.detail;
  let detail: ProjectDetail;
  const folder = FOLDER_ID.exec(id);
  if (folder) {
    const name = folder[1]!, dir = resolveProject(name);   // menolak folder di luar PROJECTS_ROOT
    detail = await getRunner().call<ProjectDetail>('analyze', { dir, id, name });
  } else {
    const known = (await getRunner().call<ProjectSummary[]>('listExamples')).some((p) => p.id === id);
    if (!known) throw bad('Proyek tidak ditemukan');
    detail = await getRunner().call<ProjectDetail>('example', { id });
  }
  projects.set(id, { at: Date.now(), detail });
  return detail;
}

/** Salinan arsitektur dengan estimasi yang diterima; hanya parameter yang ditandai tebakan pada node itu yang boleh diganti. */
export function withEstimates(arch: ProjectDetail['arch'], estimates: LabEstimate[]): ProjectDetail['arch'] {
  if (!estimates.length) return arch;
  const copy = structuredClone(arch);
  const nodes = copy.nodes as Array<Record<string, unknown> & { id: string; assumed?: string[] }>;
  for (const e of estimates) {
    const n = nodes.find((x) => x.id === e.node);
    if (!n || !n.assumed?.includes(e.key)) continue;
    n[e.key] = e.value; n.assumed = n.assumed.filter((k) => k !== e.key);
  }
  return copy;
}

export async function simulate(input: SimulateInput): Promise<SimulateResult> {
  if (peakRps(input.load) > MAX_PEAK_RPS) throw bad(`Beban puncak melebihi batas simulasi (${MAX_PEAK_RPS} request/detik). Kurangi pengguna, request per menit, atau pengali lonjakan.`);
  const detail = await getProject(input.project);
  const faults = input.faults ? detail.faults.map((f) => f.spec) : [];
  const arch = withEstimates(detail.arch, input.estimates), key = JSON.stringify([input.project, input.estimates, input.load, input.seconds, faults, input.failure]), cached = baselines.get(key);
  const out = await getRunner().call<{ applied: unknown[]; skipped: unknown[]; baseline?: SimulateRun; experiment: SimulateRun }>('simulate', {
    arch, recs: detail.recs, actions: input.actions, load: input.load, seconds: input.seconds, faults, failure: input.failure, withBaseline: !cached
  });
  const baseline = cached ?? out.baseline!;
  if (!cached) { baselines.set(key, baseline); if (baselines.size > BASELINE_CACHE_MAX) baselines.delete(baselines.keys().next().value!); }
  return { applied: out.applied, skipped: out.skipped, baseline, experiment: out.experiment };
}

/** Potensi bottleneck: urutan komponen yang jenuh lebih dulu (kondisi sekarang vs eksperimen), tahan terhadap variasi asumsi. Hasilnya di-cache. */
export async function findBottlenecks(input: BottlenecksInput): Promise<BottlenecksResult> {
  if (peakRps(input.load) > MAX_PEAK_RPS) throw bad(`Beban dasar melebihi batas simulasi (${MAX_PEAK_RPS} request/detik).`);
  const detail = await getProject(input.project), key = JSON.stringify([input.project, input.estimates, input.actions, input.load]), hit = bottlenecks.get(key);
  if (hit) return hit;
  const out = await getRunner().call<BottlenecksResult>('bottlenecks', { arch: withEstimates(detail.arch, input.estimates), recs: detail.recs, actions: input.actions, load: input.load, seed: input.project });
  bottlenecks.set(key, out); if (bottlenecks.size > BASELINE_CACHE_MAX) bottlenecks.delete(bottlenecks.keys().next().value!);
  return out;
}

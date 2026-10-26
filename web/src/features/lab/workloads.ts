// Laju dan waktu CPU per workload yang bisa diisi pengguna. Laju tidak disimpan sendiri: simulasi membagi total beban
// (pengguna x request/menit) menurut campuran (mix), jadi mengisi laju per workload berarti menghitung ulang campuran dan total.
import { totalRps } from './scenario';
import type { LabEstimate, LabLoad, LabWorkload } from './types';

/** Workload yang ikut campuran beban pengguna (sinkron, atau antrean yang tetap dipicu pengguna). Harus sama dengan syncOf di simulator/src/load.js. */
export const userWorkloads = (all: LabWorkload[]): LabWorkload[] => all.filter((w) => !w.async || w.mixed);

/** Laju (request/detik) tiap workload menurut beban sekarang. */
export function currentRates(load: LabLoad, workloads: LabWorkload[]): Record<string, number> {
  const sync = userWorkloads(workloads), sum = sync.reduce((s, w) => s + (load.mix[w.id] ?? 0), 0), total = totalRps(load), out: Record<string, number> = {};
  sync.forEach((w) => { out[w.id] = sum > 0 ? (total * (load.mix[w.id] ?? 0)) / sum : 0; });
  return out;
}

/** Beban baru setelah laju satu workload diganti: total dan campuran dihitung ulang, request/menit per pengguna dipertahankan sedekat mungkin. */
export function withRate(load: LabLoad, workloads: LabWorkload[], id: string, rate: number): LabLoad {
  const rates = { ...currentRates(load, workloads), [id]: Math.max(0, rate) }, total = Object.values(rates).reduce((s, r) => s + r, 0);
  if (!(total > 0)) return load;   // total nol tidak bisa disimulasikan
  const rpm = total * 60, users = Math.max(1, Math.round(rpm / load.rpu)), rpu = Math.min(600, Math.max(0.1, rpm / users));
  const mix = Object.fromEntries(Object.entries(rates).map(([k, r]) => [k, Math.round((r / total) * 10_000) / 100]));
  return { ...load, users, rpu, mix };
}

export const cpuEstimateOf = (estimates: LabEstimate[], id: string): LabEstimate | undefined => estimates.find((e) => e.scope === 'workload' && e.node === id && e.key === 'cpuMs');

/** Ganti (atau hapus, bila value null) waktu CPU satu workload di daftar estimasi. */
export function withCpuMs(estimates: LabEstimate[], id: string, value: number | null): LabEstimate[] {
  const rest = estimates.filter((e) => !(e.scope === 'workload' && e.node === id && e.key === 'cpuMs'));
  return value != null && value > 0 ? [...rest, { node: id, key: 'cpuMs', value, scope: 'workload' }] : rest;
}

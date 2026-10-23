// Logika murni formulir uji beban (mudah diuji): nilai awal, preset tahap, dan penyusunan muatan untuk API.
import type { LoadCriteria, LoadRequest, LoadScrape, LoadStage, NewLoadTest } from './types';

export interface FormState {
  name: string; target: string; requests: LoadRequest[]; thinkSeconds: number; stages: LoadStage[]; criteria: LoadCriteria;
  headers: Array<{ key: string; value: string }>; scrape: LoadScrape[]; confirm: boolean; playgroundId?: number;
}

export const initialForm = (): FormState => ({
  name: '', target: '', requests: [{ name: 'beranda', method: 'GET', path: '/', weight: 1 }], thinkSeconds: 1,
  stages: stagePreset('bertahap'), criteria: { p95Ms: 1000, errPct: 1 }, headers: [], scrape: [], confirm: false
});

export type PresetKind = 'cepat' | 'bertahap' | 'panjang';
const PRESETS: Record<PresetKind, { vus: number[]; seconds: number }> = {
  cepat: { vus: [5, 20, 80], seconds: 15 },
  bertahap: { vus: [10, 25, 50, 100, 200], seconds: 30 },
  panjang: { vus: [10, 25, 50, 100, 200, 400], seconds: 60 }
};
export const PRESET_LABELS: Record<PresetKind, string> = { cepat: 'Cepat (5, 20, 80 pengguna x 15 dtk)', bertahap: 'Bertahap (10 sampai 200 x 30 dtk)', panjang: 'Panjang (10 sampai 400 x 60 dtk)' };

export function stagePreset(kind: PresetKind): LoadStage[] { const p = PRESETS[kind]; return p.vus.map((vus) => ({ vus, seconds: p.seconds })); }

export const totalSeconds = (stages: LoadStage[]): number => stages.reduce((s, x) => s + x.seconds, 0);
export const peakVus = (stages: LoadStage[]): number => Math.max(0, ...stages.map((s) => s.vus));

/** Muatan untuk POST /api/loadtests. Baris kosong dibuang; target dirapikan. */
export function buildPayload(f: FormState): NewLoadTest {
  const headers: Record<string, string> = {};
  for (const h of f.headers) if (h.key.trim()) headers[h.key.trim()] = h.value;
  return {
    name: f.name.trim(), target: f.target.trim().replace(/\/+$/, ''), confirmNotProduction: true,
    requests: f.requests.map((r) => { const path = r.path.trim(); return { ...r, name: r.name.trim() || path, path, body: r.body?.trim() ? r.body.trim() : undefined }; }),
    thinkSeconds: f.thinkSeconds, headers, stages: f.stages, criteria: f.criteria, ...(f.playgroundId ? { playgroundId: f.playgroundId } : {}),
    scrape: f.scrape.filter((s) => s.label.trim() && s.url.trim() && s.metric.trim()).map((s) => ({ label: s.label.trim(), url: s.url.trim(), metric: s.metric.trim() }))
  };
}

/** Pesan masalah yang bisa dideteksi sebelum mengirim; kosong = boleh kirim. */
export function problems(f: FormState): string[] {
  const out: string[] = [];
  if (!f.name.trim()) out.push('Nama uji wajib diisi');
  if (!/^https?:\/\/\S+$/.test(f.target.trim())) out.push('Target harus berupa alamat http:// atau https://');
  if (f.requests.some((r) => !r.path.trim().startsWith('/'))) out.push('Path request harus diawali /');
  if (!f.stages.length) out.push('Minimal satu tahap');
  if (totalSeconds(f.stages) > 3600) out.push('Total durasi maksimal 3600 detik');
  if (!f.confirm) out.push('Centang konfirmasi bahwa target BUKAN produksi');
  return out;
}

// Pengumpul Vercel: menanyakan deploy produksi terakhir lewat REST API (GET /v7/deployments, otentikasi Bearer).
// Host dikunci ke api.vercel.com, jadi tidak ada risiko SSRF. Token tidak pernah masuk ke pesan galat.
import type { Verdict } from './service.js';

export interface VercelCfg { token: string; project: string; teamId?: string }
export interface Deployment { uid: string; state?: string; readyState?: string; errorCode?: string | null; errorMessage?: string | null; created: number; inspectorUrl?: string | null }

const STUCK_MS = 30 * 60_000;
export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Menilai deploy produksi terakhir (yang dibatalkan/dihapus diabaikan karena biasanya tergantikan deploy baru). */
export function deploymentVerdict(list: Deployment[], now = Date.now()): Verdict {
  const latest = [...list].sort((a, b) => b.created - a.created).find((d) => !['CANCELED', 'DELETED'].includes(d.readyState ?? d.state ?? ''));
  if (!latest) return { severity: null, title: 'Belum ada deploy produksi', detail: '' };
  const state = latest.readyState ?? latest.state ?? '';
  if (state === 'ERROR') return { severity: 'kritis', title: 'Deploy produksi terakhir gagal', detail: [latest.errorCode, latest.errorMessage, latest.inspectorUrl].filter(Boolean).join(' | ') || `Deploy ${latest.uid}` };
  if (state === 'BLOCKED') return { severity: 'peringatan', title: 'Deploy produksi diblokir', detail: latest.errorMessage || `Deploy ${latest.uid}` };
  if (['QUEUED', 'BUILDING', 'INITIALIZING'].includes(state)) {
    const min = Math.floor((now - latest.created) / 60_000);
    return now - latest.created > STUCK_MS ? { severity: 'peringatan', title: `Deploy macet (${state}, ${min} menit)`, detail: latest.inspectorUrl ?? '' } : { severity: null, title: 'Sedang membangun', detail: `${state}, ${min} menit` };
  }
  return { severity: null, title: 'Sehat', detail: `Deploy ${latest.uid} ${state === 'READY' ? 'siap' : state}` };
}

export async function check(cfg: VercelCfg, fetcher: Fetcher): Promise<{ verdict: Verdict; ms: number }> {
  const started = Date.now(), q = new URLSearchParams({ projectId: cfg.project, target: 'production', limit: '5' });
  if (cfg.teamId) q.set('teamId', cfg.teamId);
  const fail = (title: string, detail: string) => ({ verdict: { severity: 'kritis' as const, title, detail }, ms: Date.now() - started });
  try {
    const res = await fetcher(`https://api.vercel.com/v7/deployments?${q}`, { headers: { authorization: `Bearer ${cfg.token}`, 'user-agent': 'AIOps-Uptime/1.0' }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return fail('Token Vercel ditolak', 'Periksa token dan izinnya (untuk proyek milik tim, isi juga ID tim).');
    if (res.status === 400 || res.status === 404) return fail('Proyek Vercel tidak ditemukan', 'Periksa nama atau ID proyek dan ID tim.');
    if (res.status === 429) return fail('Vercel membatasi permintaan', 'Perlambat interval pemeriksaan.');
    if (res.status !== 200) return fail(`API Vercel membalas ${res.status}`, '');
    const body = (await res.json()) as { deployments?: Deployment[] };
    return { verdict: deploymentVerdict(body.deployments ?? []), ms: Date.now() - started };
  } catch (e) { return fail('API Vercel tidak terjangkau', (e as Error).name === 'TimeoutError' ? 'Waktu habis (10 dtk)' : 'Gagal menyambung'); }
}

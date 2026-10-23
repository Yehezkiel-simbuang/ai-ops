// Pemformatan tampilan (bahasa Indonesia). Fungsi murni supaya mudah diuji.
const DAY = 86_400_000;

export const fmt = (n: number | null | undefined): string => Number(n || 0).toLocaleString('id-ID');

export function usd(cost: number, known: boolean): string {
  if (!known) return '-';
  return '$' + (cost < 1 ? cost.toFixed(4) : cost.toFixed(2));
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'belum pernah';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return `${Math.round(s)} dtk lalu`;
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}

export const dateStr = (ms: number | null | undefined): string => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : '-');
export const dateTime = (ms: number): string => new Date(ms).toLocaleString('id-ID');

export function dueText(ms: number, now = Date.now()): string {
  const d = Math.ceil((ms - now) / DAY);
  if (d < 0) return `terlambat ${-d} hari`;
  return d === 0 ? 'hari ini' : `${d} hari lagi`;
}

/** Tanggal "YYYY-MM-DD" dari input date -> epoch ms pada jam tertentu (waktu lokal). */
export const dateInputToMs = (value: string, time = '09:00:00'): number | undefined => (value ? new Date(`${value}T${time}`).getTime() : undefined);

export function fileSafe(name: string): string { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }

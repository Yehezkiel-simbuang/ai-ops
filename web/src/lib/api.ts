// Klien HTTP tunggal ke backend. Semua perubahan membawa header X-AIOps (perlindungan CSRF di server).
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const UNAUTHORIZED_EVENT = 'aiops:unauthorized';

/** Dipanggil App saat sesi berakhir (401) di tengah pemakaian. */
export function onUnauthorized(fn: () => void): () => void {
  window.addEventListener(UNAUTHORIZED_EVENT, fn);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, fn);
}

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-aiops': '1' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T = { ok: boolean }>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T = { ok: boolean }>(path: string, body?: unknown) => api<T>('PATCH', path, body ?? {});
export const put = <T = { ok: boolean }>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const del = <T = { ok: boolean }>(path: string) => api<T>('DELETE', path);

/** Susun query string dari objek; nilai kosong dilewati. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

// Bentuk data cek HTTP dari backend (/api/webchecks).
export type WebStatus = 'belum' | 'sehat' | 'minor' | 'major' | 'critical';

export type WebKind = 'http' | 'vercel';

export interface WebCheck {
  id: number; kind: WebKind; has_token: boolean; name: string; url: string; interval_s: number; timeout_ms: number; expect_status: number; slow_ms: number; confirm: number; enabled: boolean;
  last_status: WebStatus; last_title: string; last_detail: string; last_code: number | null; last_ms: number | null; last_run: number | null; cert_expires: number | null;
  uptime24h: number | null; avgMs24h: number | null; samples24h: number;
}
export interface NewWebCheck { name: string; url: string; interval_s: number; slow_ms: number; confirm: number }
export interface VercelForm { token: string; project: string; teamId: string }
export interface WebResult { ts: number; ok: boolean; code: number | null; ms: number; error: string }

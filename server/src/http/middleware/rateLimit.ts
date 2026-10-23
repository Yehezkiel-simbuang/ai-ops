// Pembatas laju per klien (memori proses; aplikasi berjalan sebagai satu replika).
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { OPEN_PATHS } from './security.js';

interface LimitOptions { max: number; windowMs?: number; key?: (req: Request) => string; skipOpenPaths?: boolean }

export function limiter(o: LimitOptions): RequestHandler {
  return rateLimit({
    windowMs: o.windowMs ?? 60_000, limit: o.max, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: o.key ?? ((req) => ipKeyGenerator(req.ip ?? '')),
    skip: o.skipOpenPaths ? (req) => OPEN_PATHS.has(req.path) : undefined,
    validate: { xForwardedForHeader: false },   // 'trust proxy' diatur sengaja di app.ts; klien yang mengirim header ini tidak perlu mencemari log
    handler: (_req, res) => { res.status(429).json({ error: 'Terlalu banyak permintaan, coba lagi sebentar' }); }
  });
}

/** Batas umum untuk seluruh aplikasi. */
export const globalLimiter = (): RequestHandler => limiter({ max: 600, skipOpenPaths: true });
/** Aksi sensitif: login, ungkap/rotasi kredensial. */
export const loginLimiter = (): RequestHandler => limiter({ max: 8 });
export const sensitiveLimiter = (): RequestHandler => limiter({ max: 10 });
/** API agen: per kunci agen, bukan per IP. */
export const agentLimiter = (): RequestHandler => limiter({ max: 120, key: (req) => String(req.headers['x-aiops-key'] ?? ipKeyGenerator(req.ip ?? '')) });

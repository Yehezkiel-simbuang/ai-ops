// Header keamanan (CSP ketat, HSTS saat HTTPS), penjaga Host (anti DNS-rebinding), dan perlindungan CSRF.
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import type { Config } from '../../config.js';

/** Jalur yang boleh diakses tanpa pemeriksaan Host (probe kontainer). */
export const OPEN_PATHS = new Set(['/healthz', '/readyz']);

export function securityHeaders(cfg: Config): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        upgradeInsecureRequests: cfg.cookieSecure ? [] : null
      }
    },
    strictTransportSecurity: cfg.cookieSecure ? { maxAge: 15552000 } : false,
    crossOriginEmbedderPolicy: false,
    xFrameOptions: { action: 'deny' }
  });
}

/** Tolak Host yang tidak ada di ALLOWED_HOSTS. */
export function hostGuard(cfg: Config): RequestHandler {
  return (req, res, next) => {
    if (OPEN_PATHS.has(req.path)) return next();
    if (!cfg.allowedHosts.includes(req.hostname.toLowerCase())) { res.status(403).json({ error: 'Host ditolak' }); return; }
    next();
  };
}

/** Untuk /api: perubahan wajib membawa header X-AIOps (tidak bisa dikirim form lintas-situs), dan Origin (bila ada) harus dikenal.
 *  Pasang dengan app.use('/api', csrfGuard(cfg)); /login dikecualikan karena belum punya sesi. */
export function csrfGuard(cfg: Config): RequestHandler {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/login') return next();
    if (req.headers['x-aiops'] !== '1') { res.status(403).json({ error: 'Header X-AIOps wajib' }); return; }
    const origin = req.headers.origin;
    if (origin) {
      try { if (!cfg.allowedHosts.includes(new URL(origin).hostname.toLowerCase())) { res.status(403).json({ error: 'Origin ditolak' }); return; } }
      catch { res.status(403).json({ error: 'Origin tidak valid' }); return; }
    }
    next();
  };
}

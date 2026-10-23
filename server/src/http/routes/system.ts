// Rute non-API: probe kesehatan, metrik Prometheus, halaman Lab, dan UI (berkas statis + fallback SPA).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { Router, type Request, type Response } from 'express';
import type { Config } from '../../config.js';
import { safeEqual } from '../../crypto.js';
import type { Db } from '../../db.js';
import type { Metrics } from '../../metrics.js';
import { handle } from '../handle.js';

/** Dipasang SEBELUM penjaga Host: dipakai probe kontainer. */
export function healthRoutes(db: Db): Router {
  const r = Router();
  r.get('/healthz', (_req, res) => { res.json({ ok: true }); });
  r.get('/readyz', handle(async (_req, res) => { const ok = await db.ping(); res.status(ok ? 200 : 503).json({ ok, db: db.stats() }); }));
  return r;
}

export function metricsRoutes(cfg: Config, metrics: Metrics): Router {
  const r = Router();
  r.get('/metrics', handle(async (req, res) => {
    if (!cfg.METRICS_TOKEN) { res.status(404).type('text/plain').send('Tidak ada'); return; }
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(token, cfg.METRICS_TOKEN)) { res.status(401).type('text/plain').send('Tidak sah'); return; }
    res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  }));
  return r;
}

/** UI React hasil build. Aset ber-hash di /assets di-cache lama; index.html tidak pernah di-cache. Rute klien (mis. /insiden/3) jatuh ke index.html. */
export function uiRoutes(publicDir: string): Router {
  const r = Router(), index = resolve(publicDir, 'index.html');
  r.use(express.static(publicDir, {
    index: false,
    setHeaders: (res, path) => { res.setHeader('cache-control', path.replace(/\\/g, '/').includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'); }
  }));
  r.get(/^\/(?!api\/|agent\/)[^.]*$/, (_req: Request, res: Response) => {
    if (!existsSync(index)) { res.status(404).type('text/plain').send('UI belum dibangun (jalankan build di folder web)'); return; }
    res.set('cache-control', 'no-store').type('text/html; charset=utf-8').send(readFileSync(index, 'utf8'));
  });
  return r;
}

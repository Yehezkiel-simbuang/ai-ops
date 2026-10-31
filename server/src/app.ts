// Merakit aplikasi Express. Urutan middleware penting (dari luar ke dalam):
//   log -> header keamanan -> cookie -> probe kesehatan -> batas laju -> penjaga Host -> API agen (HMAC) -> API runner uji beban (bearer) -> body JSON -> metrik -> /api (CSRF, sesi) -> UI
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { agentApi } from './http/agentApi.js';
import { loadgenApi } from './http/loadgenApi.js';
import { errorHandler, notFound } from './http/middleware/errors.js';
import { httpMetrics } from './http/middleware/metrics.js';
import { globalLimiter } from './http/middleware/rateLimit.js';
import { hostGuard, securityHeaders } from './http/middleware/security.js';
import { apiRoutes } from './http/routes/index.js';
import { healthRoutes, metricsRoutes, uiRoutes } from './http/routes/system.js';
import './http/types.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Logger } from './logger.js';
import { createMetrics } from './metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const requestId = () => Math.random().toString(36).slice(2, 10);

export interface AppDeps { cfg: Config; db: Db; log: Logger }

export function createApp({ cfg, db, log }: AppDeps): Express {
  const app = express(), metrics = createMetrics(() => db);
  const publicDir = resolve(cfg.PUBLIC_DIR ?? resolve(here, '..', 'public')), binDir = resolve(cfg.AGENT_BIN_DIR ?? resolve(here, '..', 'agent-bin'));

  app.disable('x-powered-by');
  app.set('trust proxy', cfg.TRUST_PROXY ? 1 : false);   // satu lompatan: proxy HTTPS di depan (Caddy). Bukan "percaya semua".
  app.use(pinoHttp({ logger: log, genReqId: (req) => String(req.headers['x-request-id'] ?? requestId()), autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' } }));
  app.use(securityHeaders(cfg));
  app.use(cookieParser());
  app.use(healthRoutes(db));
  app.use(globalLimiter());
  app.use(hostGuard(cfg));
  app.use('/agent', agentApi(binDir));        // sebelum parser JSON global: butuh badan mentah
  app.use('/loadgen/v1', loadgenApi(cfg));    // runner pembangkit beban: bearer rahasia, parser JSON sendiri
  app.use(express.json({ limit: '1mb', inflate: false }));   // badan terkompresi ditolak (415): tidak ada klien sah yang memakainya, dan jalur dekompresi pernah punya celah DoS (body-parser)
  app.use(httpMetrics(metrics));
  app.use(metricsRoutes(cfg, metrics));
  app.use('/api', apiRoutes(cfg, binDir));
  app.use(uiRoutes(publicDir));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

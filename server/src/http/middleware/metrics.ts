// Mengukur durasi tiap request untuk Prometheus (label rute memakai pola, bukan URL asli, agar kardinalitas kecil).
import type { RequestHandler } from 'express';
import type { Metrics } from '../../metrics.js';

export function httpMetrics(metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ? req.baseUrl + String(req.route.path) : 'tak-dikenal';
      metrics.httpDuration.observe({ method: req.method, route, status: String(res.statusCode) }, Number(process.hrtime.bigint() - t0) / 1e9);
    });
    next();
  };
}

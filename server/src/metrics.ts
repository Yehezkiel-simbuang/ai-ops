// Metrik Prometheus untuk aplikasi ini sendiri (dilindungi METRICS_TOKEN; mati bila token tidak disetel).
import client from 'prom-client';
import type { Db } from './db.js';

export function createMetrics(getDb: () => Db | null) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpDuration = new client.Histogram({ name: 'aiops_http_request_duration_seconds', help: 'Durasi request HTTP', labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.3, 1, 3, 10], registers: [registry] });
  new client.Gauge({ name: 'aiops_db_pool_connections', help: 'Koneksi pool database', labelNames: ['state'], registers: [registry], collect() { const d = getDb(); if (!d) return; const s = d.stats(); this.set({ state: 'total' }, s.total); this.set({ state: 'idle' }, s.idle); this.set({ state: 'waiting' }, s.waiting); this.set({ state: 'max' }, s.max); } });
  return { registry, httpDuration };
}
export type Metrics = ReturnType<typeof createMetrics>;

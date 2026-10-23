// Uji beban dari UI: buat, lihat hasil, setujui (masuk antrean), batalkan, salin.
import { Router } from 'express';
import type { Config } from '../../config.js';
import { bad, metaGet } from '../../context.js';
import * as Store from '../../loadtest/store.js';
import { explain } from '../../loadtest/explain.js';
import { createSchema } from '../../loadtest/schema.js';
import { handle, idParam, parse } from '../handle.js';

export function loadtestRoutes(cfg: Config): Router {
  const r = Router(), allowed = cfg.LOADTEST_ALLOWED_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  r.get('/loadtests/status', handle(async () => {
    const seen = Number(await metaGet('loadgen_seen')) || 0, info = await metaGet('loadgen_info');
    return { enabled: !!cfg.LOADGEN_SECRET, allowedHosts: allowed, runner: { online: Date.now() - seen < 60_000, lastSeen: seen || null, info: info ? JSON.parse(info) : null } };
  }));
  r.get('/loadtests', handle(() => Store.list()));
  r.post('/loadtests', handle((req) => Store.create(parse(createSchema, req.body), req.user!.username, allowed)));
  r.get('/loadtests/compare', handle((req) => { const ids = String(req.query.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 4); if (ids.length < 2) throw bad('Pilih 2 sampai 4 uji untuk dibandingkan'); return Store.compare(ids); }));
  r.get('/loadtests/:id', handle((req) => Store.get(idParam(req))));
  r.delete('/loadtests/:id', handle(async (req) => { await Store.remove(idParam(req)); return { ok: true }; }));
  r.post('/loadtests/:id/run', handle((req) => Store.queue(idParam(req), req.user!.username)));
  r.post('/loadtests/:id/cancel', handle(async (req) => { await Store.cancel(idParam(req), req.user!.username); return { ok: true }; }));
  r.post('/loadtests/:id/explain', handle((req) => explain(idParam(req))));
  r.post('/loadtests/:id/duplicate', handle((req) => Store.duplicate(idParam(req), req.user!.username)));
  return r;
}

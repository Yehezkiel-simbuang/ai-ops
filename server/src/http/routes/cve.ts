// Cek CVE: cari satu CVE (status Ubuntu per rilis, penilaian tiap server, saran) dan pantau perkembangan perbaikannya.
import { Router } from 'express';
import * as Cve from '../../cve.js';
import { handle } from '../handle.js';
import { limiter } from '../middleware/rateLimit.js';

export function cveRoutes(): Router {
  const r = Router();
  r.get('/cve', handle(() => Cve.listWatches()));
  r.get('/cve/:id', limiter({ max: 20 }), handle((req) => Cve.lookup(String(req.params.id))));   // membaca daftar paket tiap server lewat SSH: dibatasi lajunya
  r.post('/cve/:id/watch', limiter({ max: 20 }), handle((req) => Cve.watch(String(req.params.id), req.user!.username)));
  r.delete('/cve/:id/watch', handle(async (req) => { await Cve.unwatch(String(req.params.id), req.user!.username); return { ok: true }; }));
  return r;
}

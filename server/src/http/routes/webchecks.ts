// Cek HTTP untuk layanan tanpa SSH: daftar, tambah, ubah, hapus, jalankan sekarang, dan riwayat hasil.
import { Router } from 'express';
import * as Web from '../../webchecks/service.js';
import { handle, idParam, parse } from '../handle.js';

export function webcheckRoutes(): Router {
  const r = Router();
  r.get('/webchecks', handle(() => Web.list()));
  r.post('/webchecks', handle((req) => Web.create(parse(Web.createSchema, req.body), req.user!.username)));
  r.patch('/webchecks/:id', handle((req) => Web.update(idParam(req), parse(Web.patchSchema, req.body), req.user!.username)));
  r.delete('/webchecks/:id', handle(async (req) => { await Web.remove(idParam(req), req.user!.username); return { ok: true }; }));
  r.post('/webchecks/:id/run', handle((req) => Web.runOne(idParam(req))));
  r.get('/webchecks/:id/results', handle((req) => Web.results(idParam(req), Number(req.query.hours) || 24)));
  return r;
}

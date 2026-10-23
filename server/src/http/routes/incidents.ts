// Insiden dari agen dan rekomendasi perbaikan (persetujuan -> eksekusi).
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, db } from '../../context.js';
import * as Incidents from '../../incidents.js';
import { handle, idParam, parse } from '../handle.js';

const regenerateBody = z.object({ useModel: z.boolean().optional() });
const approveBody = z.object({ steps: z.array(z.number().int()).max(20).optional() });

export function incidentRoutes(): Router {
  const r = Router();
  r.get('/incidents', handle((req) => Incidents.listIncidents(String(req.query.status ?? 'open'))));
  r.get('/incidents/:id', handle((req) => Incidents.incidentDetail(idParam(req))));
  r.post('/incidents/:id/regenerate', handle(async (req) => ({ id: await Incidents.generate(idParam(req), { useModel: parse(regenerateBody, req.body).useModel }) })));
  r.get('/recommendations/:id', handle(async (req) => {
    const id = idParam(req), rec = await db().one('SELECT * FROM recommendations WHERE id=$1', [id]);
    if (!rec) throw new HttpError(404, 'Rekomendasi tidak ada');
    return { ...rec, steps: await db().query('SELECT * FROM rec_steps WHERE rec_id=$1 ORDER BY n', [id]) };
  }));
  r.post('/recommendations/:id/approve', handle(async (req) => { await Incidents.approve(idParam(req), parse(approveBody, req.body).steps ?? null, req.user!.username); return { ok: true }; }));
  r.post('/recommendations/:id/reject', handle(async (req) => { await Incidents.reject(idParam(req), req.user!.username); return { ok: true }; }));
  return r;
}

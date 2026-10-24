// Jadwal pemeliharaan: tugas berulang/sekali, templat standar, selesai/tunda, riwayat.
import { Router } from 'express';
import { z } from 'zod';
import * as Maint from '../../maintenance.js';
import * as Patching from '../../patching.js';
import { handle, idParam, parse } from '../handle.js';

const taskBody = z.object({
  title: z.string().optional(), description: z.string().optional(), category: z.string().optional(), priority: z.string().optional(),
  every_days: z.union([z.number(), z.string(), z.null()]).optional(), due_at: z.number().nullish(), enabled: z.boolean().optional()
});
const completeBody = z.object({ notes: z.string().max(1000).optional(), done_at: z.number().optional() });

export function maintenanceRoutes(): Router {
  const r = Router();
  r.get('/maintenance', handle((req) => Maint.list({ scope: req.query.scope as string | undefined, serverId: req.query.server ? Number(req.query.server) : null })));
  r.get('/maintenance/patching', handle(() => Patching.overview()));   // sebelum /maintenance/:id
  r.get('/servers/:id/patching', handle((req) => Patching.detail(idParam(req))));
  r.get('/maintenance/templates', handle(() => Maint.TEMPLATES));
  r.put('/maintenance/:id', handle((req) => Maint.update(idParam(req), parse(taskBody, req.body) as never)));
  r.delete('/maintenance/:id', handle(async (req) => { await Maint.remove(idParam(req)); return { ok: true }; }));
  r.post('/maintenance/:id/complete', handle((req) => Maint.complete(idParam(req), req.user!.username, parse(completeBody, req.body).notes ?? '')));
  r.post('/maintenance/:id/snooze', handle((req) => Maint.snooze(idParam(req), parse(z.object({ days: z.number() }), req.body).days)));
  r.get('/servers/:id/maintenance', handle((req) => Maint.list({ serverId: idParam(req) })));
  r.get('/servers/:id/maintenance-log', handle((req) => Maint.logFor(idParam(req))));
  r.post('/servers/:id/maintenance', handle((req) => Maint.add(idParam(req), parse(taskBody, req.body) as never)));
  r.post('/servers/:id/maintenance/templates', handle(async (req) => ({ added: await Maint.addTemplates(idParam(req), parse(z.object({ ids: z.array(z.string()).max(20) }), req.body).ids) })));
  return r;
}

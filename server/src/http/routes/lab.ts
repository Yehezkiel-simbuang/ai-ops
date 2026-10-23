// Lab arsitektur: proyek + rekomendasi awal, simulasi eksperimen (komponen yang ditambahkan), skenario tersimpan.
import { Router } from 'express';
import * as Designs from '../../lab/designs.js';
import { estimate } from '../../lab/estimate.js';
import * as Lab from '../../lab/service.js';
import { bottlenecksSchema, designSchema, simulateSchema } from '../../lab/types.js';
import { z } from 'zod';
import { handle, idParam, parse, strParam } from '../handle.js';

const estimateRequestSchema = z.object({ project: z.string().min(1).max(120) });

export function labRoutes(): Router {
  const r = Router();
  r.get('/lab/projects', handle(() => Lab.listProjects()));
  r.get('/lab/projects/:id', handle((req) => Lab.getProject(strParam(req))));
  r.post('/lab/simulate', handle((req) => Lab.simulate(parse(simulateSchema, req.body))));
  r.post('/lab/estimate', handle((req) => estimate(parse(estimateRequestSchema, req.body).project)));
  r.post('/lab/bottlenecks', handle((req) => Lab.findBottlenecks(parse(bottlenecksSchema, req.body))));
  r.get('/lab/designs', handle((req) => Designs.list(String(req.query.project ?? ''))));
  r.post('/lab/designs', handle((req) => Designs.save(parse(designSchema, req.body))));
  r.delete('/lab/designs/:id', handle(async (req) => { await Designs.remove(idParam(req)); return { ok: true }; }));
  return r;
}

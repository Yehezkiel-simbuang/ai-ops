// Playground: server uji tempat susunan Docker Compose dipasang, diuji, lalu dicopot.
import { Router } from 'express';
import { z } from 'zod';
import { buildCompose } from '../../playground/builder.js';
import { analyze } from '../../playground/compose.js';
import * as Playground from '../../playground/service.js';
import { handle, idParam, parse } from '../handle.js';

const analyzeBody = z.object({ compose: z.string().max(200_000) });

export function playgroundRoutes(): Router {
  const r = Router();
  r.get('/playground', handle(() => Playground.list()));
  r.post('/playground/build', handle((req) => { const compose = buildCompose(req.body); return { compose, analysis: analyze(compose) }; }));
  r.post('/playground/analyze', handle((req) => analyze(parse(analyzeBody, req.body).compose)));
  r.post('/playground', handle((req) => Playground.create(parse(Playground.createSchema, req.body), req.user!.username)));
  r.get('/playground/:id', handle((req) => Playground.get(idParam(req))));
  r.put('/playground/:id', handle((req) => Playground.update(idParam(req), parse(Playground.patchSchema, req.body), req.user!.username)));
  r.delete('/playground/:id', handle(async (req) => { await Playground.remove(idParam(req), req.user!.username); return { ok: true }; }));
  r.post('/playground/:id/deploy', handle((req) => Playground.deploy(idParam(req), req.user!.username)));
  r.post('/playground/:id/stop', handle((req) => Playground.stop(idParam(req), req.user!.username)));
  r.get('/playground/:id/containers', handle((req) => Playground.containers(idParam(req))));
  r.post('/playground/:id/check', handle((req) => Playground.reconcile(idParam(req))));
  r.get('/playground/:id/logs', handle(async (req) => ({ text: await Playground.logs(idParam(req)) })));
  return r;
}

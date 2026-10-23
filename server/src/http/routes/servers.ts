// Inventaris server dasar: CRUD, uji koneksi.
import { Router } from 'express';
import { z } from 'zod';
import * as Servers from '../../servers.js';
import { handle, idParam, parse } from '../handle.js';

const serverBody = z.object({
  generate_key: z.boolean().optional(), playground: z.boolean().optional(),
  name: z.string().optional(), host: z.string().optional(), port: z.coerce.number().optional(), username: z.string().optional(), key_path: z.string().optional(), ssh_key: z.string().optional(),
  use_sudo: z.boolean().optional(), services: z.string().optional(), notes: z.string().optional(), exec_via: z.string().optional()
});

export function serverRoutes(): Router {
  const r = Router();
  r.get('/servers', handle(() => Servers.list()));
  r.post('/servers', handle((req) => Servers.save(parse(serverBody, req.body))));
  r.put('/servers/:id', handle((req) => Servers.save(parse(serverBody, req.body), idParam(req))));
  r.delete('/servers/:id', handle(async (req) => { await Servers.remove(idParam(req)); return { ok: true }; }));
  r.post('/servers/:id/test', handle((req) => Servers.test(idParam(req))));
  return r;
}

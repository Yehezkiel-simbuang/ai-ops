// Dokumentasi server: profil (fungsi, alamat, layanan, dependensi), fakta dari server, ekspor tanpa rahasia.
import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../context.js';
import * as Docs from '../../docs.js';
import * as Servers from '../../servers.js';
import { handle, idParam, parse } from '../handle.js';

const addressBody = z.object({ label: z.string().optional(), kind: z.string().optional(), address: z.string(), is_primary: z.boolean().optional(), notes: z.string().optional() });
const serviceBody = z.object({ name: z.string(), port: z.union([z.number(), z.string(), z.null()]).optional(), protocol: z.string().optional(), url: z.string().optional(), notes: z.string().optional() })
  .transform((s) => ({ ...s, port: s.port === '' || s.port == null ? null : Number(s.port) }));
const profileBody = z.object({
  purpose: z.string().optional(), environment: z.string().optional(), tags: z.array(z.string()).optional(), location: z.string().optional(), owner: z.string().optional(), runbook: z.string().optional(),
  addresses: z.array(addressBody).optional(), services: z.array(serviceBody).optional(), dependsOn: z.array(z.object({ id: z.coerce.number(), note: z.string().optional() })).optional()
});
const safeFileName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '_');

export function inventoryRoutes(): Router {
  const r = Router();
  r.get('/inventory', handle((req) => Docs.inventory({ q: req.query.q as string | undefined, env: req.query.env as string | undefined, tag: req.query.tag as string | undefined })));
  r.get('/inventory.csv', handle(async (_req, res) => { res.type('text/csv; charset=utf-8').set('content-disposition', 'attachment; filename="inventaris-server.csv"').send(await Docs.exportCsv()); }));
  r.get('/servers/:id/profile', handle((req) => Docs.getProfile(idParam(req))));
  r.put('/servers/:id/profile', handle(async (req) => { const id = idParam(req); await Docs.updateProfile(id, parse(profileBody, req.body) as never, req.user!.username); return Docs.getProfile(id); }));
  r.post('/servers/:id/facts', handle((req) => Docs.collectFacts(idParam(req), req.user!.username)));
  r.get('/servers/:id/export.md', handle(async (req, res) => {
    const id = idParam(req), s = await Servers.get(id); if (!s) throw new HttpError(404, 'Server tidak ada');
    res.type('text/markdown; charset=utf-8').set('content-disposition', `attachment; filename="${safeFileName(s.name)}.md"`).send(await Docs.exportMarkdown(id));
  }));
  return r;
}

// Kanal notifikasi (Telegram, ntfy, webhook, email) dan riwayat pengiriman.
import { Router } from 'express';
import { z } from 'zod';
import * as Notify from '../../notify.js';
import { handle, idParam, parse } from '../handle.js';

const channelBody = z.object({ type: z.string().optional(), name: z.string().optional(), config: z.record(z.string(), z.unknown()).optional(), min_level: z.string().optional(), enabled: z.boolean().optional() });

export function channelRoutes(): Router {
  const r = Router();
  r.get('/channels', handle(() => Notify.list()));
  r.post('/channels', handle((req) => Notify.save(parse(channelBody, req.body))));
  r.put('/channels/:id', handle((req) => Notify.save(parse(channelBody, req.body), idParam(req))));
  r.delete('/channels/:id', handle(async (req) => { await Notify.remove(idParam(req)); return { ok: true }; }));
  r.post('/channels/:id/test', handle((req) => Notify.test(idParam(req))));
  r.get('/notifications', handle(() => Notify.history()));
  return r;
}

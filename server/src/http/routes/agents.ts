// Kelola agen dari UI: status, terbitkan/rotasi kunci + panduan pemasangan, hapus. (API agen sendiri ada di agentApi.ts.)
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { binaryInfo, guideWarnings, installGuide } from '../../agent-install.js';
import * as Agents from '../../agents.js';
import type { Config } from '../../config.js';
import { HttpError } from '../../context.js';
import * as Incidents from '../../incidents.js';
import * as Servers from '../../servers.js';
import { handle, idParam, parse } from '../handle.js';

const issueBody = z.object({ exec: z.boolean().optional() });

export function agentAdminRoutes(cfg: Config, binDir: string): Router {
  const r = Router();
  const publicUrl = (req: Request) => (cfg.PUBLIC_URL ?? `${cfg.cookieSecure ? 'https' : 'http'}://${req.headers.host}`).replace(/\/+$/, '');
  const serverOr404 = async (id: number) => { const s = await Servers.get(id); if (!s) throw new HttpError(404, 'Server tidak ada'); return s; };

  r.get('/agents', handle(() => Agents.fleet()));   // armada: semua server dengan status agennya
  r.get('/servers/:id/agent', handle(async (req) => {
    const id = idParam(req), s = await serverOr404(id), agent = await Agents.statusOf(id);
    return { agent, path: Incidents.execPath(s, agent as never), binaries: Object.keys(binaryInfo(binDir)) };
  }));
  r.post('/servers/:id/agent', handle(async (req) => {
    const id = idParam(req), s = await serverOr404(id), b = parse(issueBody, req.body), cred = await Agents.issue(id);
    return { keyId: cred.keyId, rotated: cred.rotated, warnings: guideWarnings(publicUrl(req)), ...installGuide(publicUrl(req), cred, { exec: !!b.exec, services: s.services ? s.services.split(',') : [] }), note: 'Secret hanya ditampilkan sekali. Simpan di server saja.' };
  }));
  r.delete('/servers/:id/agent', handle(async (req) => { await Agents.remove(idParam(req)); return { ok: true }; }));
  return r;
}

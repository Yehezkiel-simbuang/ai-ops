// Antarmuka untuk agen di server (/agent/*). Autentikasi HMAC per permintaan (bukan sesi/cookie); badan mentah dipertahankan untuk tanda tangan.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import { AGENT_FILES } from '../agent-install.js';
import * as Agents from '../agents.js';
import { bad } from '../context.js';
import * as Incidents from '../incidents.js';
import { handle } from './handle.js';
import { agentLimiter } from './middleware/rateLimit.js';

const batchBody = z.object({ events: z.array(z.unknown()).max(50) });
const heartbeatBody = z.object({ v: z.string().max(40).optional(), host: z.string().max(120).optional(), up: z.number().optional(), exec: z.boolean().optional(), open: z.array(z.string()).max(50).nullish(), hb: z.number().optional() });
const resultBody = z.object({ exit: z.number().int().optional(), stdout: z.string().max(40000).optional(), stderr: z.string().max(40000).optional(), rejected: z.string().max(300).optional() });

/** Unduhan biner (publik: bukan rahasia; integritas lewat SHA256SUMS). */
function downloadRoutes(binDir: string): Router {
  const r = Router();
  r.get('/download/:file', handle((req, res) => {
    const file = String(req.params.file);
    if (!AGENT_FILES.test(file)) { res.status(404).type('text/plain').send('Tidak ada'); return; }
    const path = resolve(binDir, file);
    if (!existsSync(path)) { res.status(404).type('text/plain').send('Biner agen belum dibangun di image ini'); return; }
    res.type(file === 'SHA256SUMS' ? 'text/plain' : 'application/octet-stream').set('content-length', String(statSync(path).size)).send(readFileSync(path));
  }));
  return r;
}

/** Verifikasi tanda tangan HMAC. Jawaban seragam: tidak membedakan "kunci tidak ada" dari "tanda tangan salah". */
const authenticateAgent: express.RequestHandler = async (req, res, next) => {
  const keyId = String(req.headers['x-aiops-key'] ?? ''), ts = String(req.headers['x-aiops-ts'] ?? ''), sig = String(req.headers['x-aiops-sig'] ?? '');
  const agent = keyId ? await Agents.byKey(keyId) : null;
  const signedPath = req.originalUrl.split('?')[0]!;   // yang ditandatangani agen: jalur lengkap tanpa query
  if (!agent || !agent.secret || !Agents.verifyRequest(agent.secret, ts, req.method, signedPath, req.rawBody ?? Buffer.alloc(0), sig)) {
    req.log.warn({ keyId: keyId.slice(0, 20), ip: req.ip }, 'permintaan agen ditolak');
    res.status(401).json({ error: 'tidak sah' });
    return;
  }
  req.agent = agent;
  next();
};

function v1Routes(): Router {
  const r = Router();
  r.use(agentLimiter());
  r.use(express.json({ limit: '256kb', verify: (req, _res, buf) => { (req as express.Request).rawBody = buf; } }));
  r.use(authenticateAgent);

  r.post('/heartbeat', handle((req) => {
    const hb = heartbeatBody.safeParse(req.body ?? {});
    if (!hb.success) throw bad('detak jantung tidak valid');
    return Agents.heartbeat(req.agent!.server_id, hb.data, req.ip ?? '');
  }));
  r.post('/events', handle(async (req) => {
    const b = batchBody.safeParse(req.body ?? {});
    if (!b.success) throw bad('badan tidak valid');
    const good: Incidents.AgentEvent[] = []; let rejected = 0;
    for (const e of b.data.events) { const p = Incidents.eventSchema.safeParse(e); if (p.success) good.push(p.data); else rejected++; }
    if (!good.length && rejected) throw bad('semua kejadian tidak valid');
    return { ok: true, ...(await Incidents.ingest(req.agent!.server_id, good)), rejected };
  }));
  r.get('/commands/poll', handle((req, res) => {
    const agent = req.agent!, wait = Math.min(25, Math.max(0, Number(req.query.wait) || 0));
    if (!agent.exec_enabled) return { commands: [], poll: false };   // agen belum menyatakan boleh mengeksekusi: tidak ada yang diberikan
    const ctl = new AbortController(); res.on('close', () => ctl.abort());
    return Agents.takeCommands(agent.server_id, agent.secret, wait, ctl.signal);
  }));
  r.post('/commands/:id/result', handle(async (req) => {
    const parsed = resultBody.safeParse(req.body ?? {});
    if (!parsed.success) throw bad('hasil tidak valid');
    return { ok: await Agents.recordResult(req.agent!.server_id, String(req.params.id), parsed.data) };
  }));
  return r;
}

export function agentApi(binDir: string): Router {
  const r = Router();
  r.use(downloadRoutes(binDir));
  r.use('/v1', v1Routes());
  return r;
}

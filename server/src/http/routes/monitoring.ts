// Monitoring: pemeriksaan layanan, paket, metrik, peringatan.
import { Router } from 'express';
import { z } from 'zod';
import * as Checks from '../../checks.js';
import * as Scan from '../../checks-scan.js';
import * as Custom from '../../custom-packs.js';
import * as Monitor from '../../monitor.js';
import * as Servers from '../../servers.js';
import * as Standards from '../../standards.js';
import { handle, idParam, parse } from '../handle.js';

const checkBody = z.object({
  name: z.string(), type: z.string(), params: z.record(z.string(), z.unknown()).optional(), warn: z.any().optional(), crit: z.any().optional(),
  dir: z.string().optional(), delta: z.boolean().optional(), confirm: z.coerce.number().optional()
});
const packBody = z.object({ pack: z.string(), opts: z.record(z.string(), z.unknown()).optional() });
const SERIES = ['load5', 'mem_avail_pct', 'disk_root_pct', 'io_psi10', 'swap_used_mb'];

async function monitorView(serverId: number, minutesParam: unknown) {
  const minutes = Math.min(1440, Number(minutesParam) || 120), series: Record<string, unknown> = {};
  for (const name of SERIES) series[name] = await Monitor.series(serverId, name, minutes);
  return { server: await Servers.getPublic(serverId), latest: await Monitor.latest(serverId), series, alerts: await Monitor.alerts(serverId, false), reports: await Monitor.reports(serverId), checks: await Monitor.listChecks(serverId) };
}

export function monitoringRoutes(): Router {
  const r = Router();
  r.get('/checks/meta', handle(() => Checks.meta()));
  r.post('/servers/:id/check', handle((req) => Monitor.check(idParam(req))));
  r.post('/servers/:id/analyze', handle((req) => Monitor.analyze(idParam(req))));
  r.post('/servers/:id/discover', handle((req) => Monitor.discover(idParam(req))));
  r.get('/standards', handle(() => Standards.getStandards()));
  r.put('/standards', handle((req) => Standards.setStandard(parse(Standards.standardBody, req.body ?? {}), req.user!.username)));
  r.post('/standards/suggest', handle(() => Standards.suggest()));
  r.post('/standards/packs', handle(async (req) => {   // layanan yang belum ada di Standar: simpan sebagai standar baru, dan (bila serverId diisi) langsung pasang di server itu
    const b = parse(Custom.customBody, req.body ?? {}), pack = await Custom.createCustomPack(b, req.user!.username);
    return { pack, added: b.serverId ? await Monitor.applyPack(b.serverId, pack.id) : [] };
  }));
  r.delete('/standards/packs/:id', handle(async (req) => { await Custom.removeCustomPack(String(req.params.id), req.user!.username); return { ok: true }; }));
  r.get('/servers/:id/scan', handle((req) => Scan.scan(idParam(req))));
  r.post('/servers/:id/checks/try', handle((req) => Scan.tryCheck(idParam(req), parse(Scan.tryBody, req.body))));
  r.post('/servers/:id/checks/suggest', handle((req) => Scan.suggest(idParam(req), parse(z.object({ units: z.array(z.string().max(80)).max(25).default([]) }), req.body ?? {}).units)));
  r.get('/servers/:id/checks', handle((req) => Monitor.listChecks(idParam(req))));
  r.post('/servers/:id/checks', handle(async (req) => ({ added: await Monitor.addChecks(idParam(req), [parse(checkBody, req.body) as Checks.CheckDef]) })));
  r.post('/servers/:id/packs', handle(async (req) => { const b = parse(packBody, req.body); return { added: await Monitor.applyPack(idParam(req), b.pack, b.opts ?? {}) }; }));
  r.get('/servers/:id/monitor', handle((req) => monitorView(idParam(req), req.query.minutes)));
  r.put('/checks/:id', handle((req) => Monitor.updateCheck(idParam(req), (req.body ?? {}) as Record<string, unknown>)));
  r.delete('/checks/:id', handle(async (req) => { await Monitor.deleteCheck(idParam(req)); return { ok: true }; }));
  r.post('/alerts/:id/ack', handle(async (req) => { await Monitor.ackAlert(idParam(req)); return { ok: true }; }));
  return r;
}

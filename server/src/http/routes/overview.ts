// Ringkasan beranda: server, persetujuan menunggu, insiden terbuka, pemeliharaan, pemakaian token.
import { Router } from 'express';
import { db } from '../../context.js';
import * as Incidents from '../../incidents.js';
import * as Maint from '../../maintenance.js';
import * as Monitor from '../../monitor.js';
import * as Servers from '../../servers.js';
import * as Store from '../../store.js';
import * as Vault from '../../vault.js';
import { handle } from '../handle.js';

async function overview() {
  const servers = (await Servers.list()).map((s) => ({ id: s.id, name: s.name, host: s.host, status: s.last_status, open_alerts: s.open_alerts, last_seen: s.last_seen }));
  const pending = await db().query("SELECT c.id, c.run_id, c.command, c.purpose, c.reason, r.name AS run_name FROM commands c JOIN runs r ON r.id=c.run_id WHERE c.status='pending_approval' ORDER BY c.id");
  const incidents = await Incidents.listIncidents('open');
  const recsWaiting = (await db().one<{ c: number }>("SELECT COUNT(*)::int AS c FROM recommendations WHERE status='proposed' AND (kind='patch' OR incident_id IN (SELECT id FROM incidents WHERE status='open'))"))!.c;
  return {
    servers, pending, incidents: incidents.slice(0, 6), recsWaiting,
    maintenance: { overdue: (await Maint.list({ scope: 'overdue' })).length, soon: (await Maint.list({ scope: 'soon' })).length },
    rotationDue: (await Vault.list(null)).filter((c) => c.rotation_overdue).length,
    runs: (await Store.runs()).slice(0, 5), usage: (await Store.summary(7)).total, alerts: (await Monitor.alerts(null, true)).filter((a) => (a as { level?: string }).level !== 'info').slice(0, 8),
    setupReady: !!(await Store.getRole('setup')), monitorReady: !!(await Store.getRole('monitor'))
  };
}

export function overviewRoutes(): Router {
  const r = Router();
  r.get('/overview', handle(overview));
  return r;
}

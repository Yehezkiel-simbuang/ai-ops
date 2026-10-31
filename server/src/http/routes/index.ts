// Menyusun seluruh rute /api. Urutan: CSRF -> login (publik) -> wajib sesi -> rute per fitur.
import { Router } from 'express';
import type { Config } from '../../config.js';
import { csrfGuard } from '../middleware/security.js';
import { requireApiSession } from '../middleware/session.js';
import { agentAdminRoutes } from './agents.js';
import { accountRoutes, loginRoutes } from './auth.js';
import { channelRoutes } from './channels.js';
import { cveRoutes } from './cve.js';
import { incidentRoutes } from './incidents.js';
import { labRoutes } from './lab.js';
import { loadtestRoutes } from './loadtests.js';
import { inventoryRoutes } from './inventory.js';
import { maintenanceRoutes } from './maintenance.js';
import { monitoringRoutes } from './monitoring.js';
import { overviewRoutes } from './overview.js';
import { runRoutes } from './runs.js';
import { serverRoutes } from './servers.js';
import { settingsRoutes } from './settings.js';
import { vaultRoutes } from './vault.js';
import { playgroundRoutes } from './playground.js';
import { webcheckRoutes } from './webchecks.js';

export function apiRoutes(cfg: Config, binDir: string): Router {
  const api = Router();
  api.use(csrfGuard(cfg));
  api.use(loginRoutes(cfg));
  api.use(requireApiSession(cfg));
  for (const feature of [accountRoutes(), overviewRoutes(), settingsRoutes(), channelRoutes(), serverRoutes(), monitoringRoutes(), agentAdminRoutes(cfg, binDir), incidentRoutes(), inventoryRoutes(), labRoutes(), webcheckRoutes(), playgroundRoutes(), loadtestRoutes(cfg), vaultRoutes(), maintenanceRoutes(), runRoutes(), cveRoutes()]) api.use(feature);
  return api;
}

// Titik masuk: konfigurasi -> database + migrasi -> HTTP -> scheduler. Berhenti rapi saat SIGTERM/SIGINT.
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import * as Agent from './agent.js';
import * as Agents from './agents.js';
import * as Auth from './auth.js';
import { loadConfig } from './config.js';
import { setCtx } from './context.js';
import { initCrypto } from './crypto.js';
import { Db, migrate } from './db.js';
import * as Cve from './cve.js';
import * as Incidents from './incidents.js';
import * as LoadTests from './loadtest/store.js';
import { closeLab } from './lab/service.js';
import { createLogger } from './logger.js';
import * as Maint from './maintenance.js';
import * as Playground from './playground/service.js';
import * as WebChecks from './webchecks/service.js';
import * as Monitor from './monitor.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig(); initCrypto(cfg.MASTER_KEY, cfg.masterKeyPrevious);
  const log = createLogger(cfg.LOG_LEVEL);
  const db = new Db(cfg, (e) => log.error({ err: e.message }, 'koneksi database idle error'));
  setCtx({ db, cfg, log });

  // database bisa belum siap saat kontainer start bersamaan (compose): coba ulang
  for (let i = 1; ; i++) { if (await db.ping()) break; if (i >= 30) throw new Error('Database tidak bisa dihubungi setelah 30 percobaan'); log.warn(`menunggu database (${i}/30)`); await sleep(1000); }
  const applied = await migrate(db, MIGRATIONS, (m) => log.info(m), cfg.DB_SCHEMA); if (!applied.length) log.info('skema sudah terbaru');
  await Auth.ensureAdmin(cfg); await Agent.recover(); await Incidents.recover(); await Playground.recover();
  Monitor.onTick(() => Agents.watchdog()); Monitor.onTick(() => Incidents.purge()); Monitor.onTick(() => Cve.tick()); Monitor.onTick(async () => { await LoadTests.watchdog(); }); Monitor.onTick(async () => { await Maint.runDigest(); }); Monitor.onTick(() => WebChecks.runDue());

  const server = createApp({ cfg, db, log }).listen(cfg.PORT, cfg.HOST, () => log.info({ host: cfg.HOST, port: cfg.PORT }, 'server mendengarkan'));
  if (cfg.RUN_SCHEDULER) Monitor.start();

  let closing = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (closing) return; closing = true; log.info({ sig }, 'mematikan layanan');
    const force = setTimeout(() => { log.error('shutdown melewati batas waktu, keluar paksa'); process.exit(1); }, 20_000); force.unref();
    try {
      await Monitor.stop(); await closeLab();
      server.closeIdleConnections();
      await new Promise<void>((done) => { server.close(() => done()); setTimeout(() => server.closeAllConnections(), 5000).unref(); });   // long-poll agen ditutup paksa setelah 5 dtk
      await db.close(); log.info('selesai'); process.exit(0);
    } catch (e) { log.error({ err: (e as Error).message }, 'shutdown gagal'); process.exit(1); }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM')); process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error({ err: (e as Error)?.message ?? String(e) }, 'unhandledRejection'));
  process.on('uncaughtException', (e) => { log.fatal({ err: e.message }, 'uncaughtException'); void shutdown('uncaughtException'); });
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

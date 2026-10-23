// Menjalankan migrasi saja (untuk CI/CD atau langkah init): node dist/migrate-cli.js
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Db, migrate } from './db.js';

const cfg = loadConfig({ ...process.env, MASTER_KEY: process.env.MASTER_KEY ?? '0'.repeat(64) });
const db = new Db(cfg, (e) => console.error('db error:', e.message));
migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)), (m) => console.log(m), cfg.DB_SCHEMA)
  .then((a) => { console.log(a.length ? `${a.length} migrasi diterapkan` : 'skema sudah terbaru'); return db.close(); })
  .catch((e) => { console.error(e.message); process.exit(1); });

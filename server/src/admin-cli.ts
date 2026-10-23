// Pemulihan akses (dijalankan di server): node dist/admin-cli.js reset-password [pengguna]
// Mengembalikan password ke bawaan dan memaksa penggantian saat masuk berikutnya. Semua sesi pengguna itu dicabut.
import { loadConfig } from './config.js';
import { setCtx } from './context.js';
import { initCrypto } from './crypto.js';
import { Db } from './db.js';
import { createLogger } from './logger.js';
import * as Auth from './auth.js';

const [cmd, userArg] = process.argv.slice(2);
if (cmd !== 'reset-password') { console.error('Pakai: node dist/admin-cli.js reset-password [pengguna]'); process.exit(2); }
const cfg = loadConfig(), log = createLogger('silent'), db = new Db(cfg, (e) => console.error('db error:', e.message));
initCrypto(cfg.MASTER_KEY); setCtx({ db, cfg, log });
const username = userArg ?? cfg.ADMIN_USERNAME;
Auth.resetPassword(username)
  .then(async (ok) => {
    console.log(ok ? `Password ${username} dikembalikan ke ${Auth.DEFAULT_PASSWORD} dan wajib diganti saat masuk. Semua sesi dicabut.` : `Pengguna "${username}" tidak ada.`);
    await db.close(); process.exit(ok ? 0 : 1);
  })
  .catch((e) => { console.error(e.message); process.exit(1); });

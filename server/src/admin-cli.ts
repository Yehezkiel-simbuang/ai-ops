// Perintah pemeliharaan (dijalankan di server):
//   node dist/admin-cli.js reset-password [pengguna]   Mengembalikan password ke bawaan dan memaksa penggantian saat masuk berikutnya. Semua sesi pengguna itu dicabut dan kunci akun dibuka.
//   node dist/admin-cli.js rotate-key                  Mengenkripsi ulang semua rahasia dengan MASTER_KEY aktif (kunci lama ada di MASTER_KEY_PREVIOUS).
import { loadConfig } from './config.js';
import { setCtx } from './context.js';
import { initCrypto } from './crypto.js';
import { Db } from './db.js';
import { createLogger } from './logger.js';
import * as Auth from './auth.js';
import { rotateAll } from './rotate.js';

const [cmd, userArg] = process.argv.slice(2);
if (cmd !== 'reset-password' && cmd !== 'rotate-key') { console.error('Pakai: node dist/admin-cli.js reset-password [pengguna] | rotate-key'); process.exit(2); }
const cfg = loadConfig(), log = createLogger('silent'), db = new Db(cfg, (e) => console.error('db error:', e.message));
initCrypto(cfg.MASTER_KEY, cfg.masterKeyPrevious); setCtx({ db, cfg, log });

const run = async (): Promise<number> => {
  if (cmd === 'rotate-key') {
    const r = await rotateAll();
    console.log(`Dienkripsi ulang: ${r.rotated}. Sudah memakai kunci aktif: ${r.skipped}. Tidak terbaca: ${r.unreadable.length}.`);
    for (const u of r.unreadable) console.log(`  - ${u.table} #${u.id}: tidak bisa dibuka dengan kunci mana pun (biarkan MASTER_KEY_PREVIOUS sampai ketemu kunci yang benar)`);
    if (!r.unreadable.length) console.log('Semua rahasia sudah memakai kunci aktif. MASTER_KEY_PREVIOUS boleh dibuang.');
    return r.unreadable.length ? 1 : 0;
  }
  const username = userArg ?? cfg.ADMIN_USERNAME, ok = await Auth.resetPassword(username);
  console.log(ok ? `Password ${username} dikembalikan ke ${Auth.DEFAULT_PASSWORD} dan wajib diganti saat masuk. Semua sesi dicabut.` : `Pengguna "${username}" tidak ada.`);
  return ok ? 0 : 1;
};
run().then(async (code) => { await db.close(); process.exit(code); }).catch((e) => { console.error(e.message); process.exit(1); });

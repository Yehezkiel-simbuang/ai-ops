// Enkripsi ulang semua rahasia dengan kunci aktif (MASTER_KEY) setelah kunci diganti.
// Urutan rotasi: 1) pindahkan MASTER_KEY lama ke MASTER_KEY_PREVIOUS, isi MASTER_KEY baru; 2) jalankan `rotate-key`; 3) buang MASTER_KEY_PREVIOUS.
import { db } from './context.js';
import { needsRotation, open, seal } from './crypto.js';

/** Semua kolom tersegel: [tabel, kolom kunci utama, kolom rahasia]. */
export const SEALED_COLUMNS: Array<[string, string, string]> = [
  ['servers', 'id', 'ssh_key_enc'], ['providers', 'id', 'api_key_enc'], ['credentials', 'id', 'secret_enc'], ['credential_versions', 'id', 'secret_enc'],
  ['channels', 'id', 'config_enc'], ['load_tests', 'id', 'headers_enc'], ['web_checks', 'id', 'provider_enc'], ['playground_deploys', 'id', 'compose_enc'], ['agents', 'server_id', 'secret_enc']
];

export interface RotateReport { rotated: number; skipped: number; unreadable: Array<{ table: string; id: string | number }> }

/** Setiap nilai dibuka lalu disegel ulang; nilai yang tidak bisa dibuka dibiarkan apa adanya (tidak ditimpa kosong) dan dilaporkan. */
export async function rotateAll(): Promise<RotateReport> {
  const rep: RotateReport = { rotated: 0, skipped: 0, unreadable: [] };
  for (const [table, pk, col] of SEALED_COLUMNS) {
    await db().tx(async (t) => {
      for (const r of await t.query(`SELECT ${pk} AS pk, ${col} AS v FROM ${table} WHERE ${col} <> '' FOR UPDATE`)) {
        if (!needsRotation(r.v)) { rep.skipped++; continue; }
        const plain = open(r.v);
        if (!plain) { rep.unreadable.push({ table, id: r.pk }); continue; }
        await t.exec(`UPDATE ${table} SET ${col}=$1 WHERE ${pk}=$2`, [seal(plain), r.pk]); rep.rotated++;
      }
    });
  }
  return rep;
}

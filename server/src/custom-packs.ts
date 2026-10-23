// Layanan standar buatan pengguna (tabel custom_packs): melengkapi paket bawaan (PACKS di checks.ts) saat layanan di server belum ada di Standar.
// Setiap pemeriksaan tetap melewati validasi tipe yang sama; perintah kustom wajib baca-saja (Safety lewat buildCommand).
import { z } from 'zod';
import * as Checks from './checks.js';
import { audit, bad, db } from './context.js';

export interface CustomPack { id: string; label: string; unit: string; checks: Checks.CheckDef[] }

const checkSchema = z.object({
  name: z.string().trim().min(1).max(100), type: z.string().min(1).max(40), params: z.record(z.string(), z.unknown()).default({}),
  warn: z.number().nullable().optional(), crit: z.number().nullable().optional(), dir: z.enum(['gt', 'lt']).default('gt'), confirm: z.number().int().min(1).max(10).optional(), delta: z.boolean().optional()
});
export const customBody = z.object({ unit: z.string().regex(Checks.V.unit), label: z.string().trim().min(1).max(80).optional(), checks: z.array(checkSchema).min(1).max(20), serverId: z.number().int().positive().optional() });

export const packId = (unit: string): string => `custom-${unit.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

export async function customPacks(): Promise<CustomPack[]> {
  return (await db().query<CustomPack>('SELECT id, unit, label, checks FROM custom_packs ORDER BY label')).map((r) => ({ ...r, checks: r.checks ?? [] }));
}

/** Paket bawaan ditambah paket buatan pengguna, dalam bentuk yang sama. */
export async function allPacks(): Promise<Record<string, Checks.PackDef>> {
  const out: Record<string, Checks.PackDef> = { ...Checks.PACKS };
  for (const p of await customPacks()) out[p.id] = { label: p.label, hint: `Standar buatan sendiri untuk unit ${p.unit}`, fields: [], make: () => p.checks.map((c) => ({ ...c })) };
  return out;
}

/** Paket buatan pengguna yang unitnya sedang berjalan menurut keluaran DISCOVER. */
export function detectCustom(out: string, packs: CustomPack[]): CustomPack[] {
  const units = new Set(String(out).split('\n').flatMap((l) => (l.startsWith('unit=') ? [l.slice(5).replace(/\.service$/, '')] : [])));
  return packs.filter((p) => units.has(p.unit));
}

/** Nama paket bawaan yang sudah mengenali unit ini (selain "host"), atau null. */
export const builtinFor = (unit: string): string | null => Object.keys(Checks.suggest(`unit=${unit}.service`)).find((k) => k !== 'host') ?? null;

function validate(c: z.infer<typeof checkSchema>): Checks.CheckDef {
  if (!Checks.TYPES[c.type]) throw bad('Tipe pemeriksaan tidak dikenal');
  try { Checks.buildCommand({ type: c.type, params: c.params }); } catch (e) { throw bad((e as Error).message); }   // parameter tidak valid atau perintah tidak baca-saja
  const order = Checks.orderProblem(c.dir, c.warn ?? null, c.crit ?? null); if (order) throw bad(order);
  return { name: c.name, type: c.type, params: c.params, warn: c.warn ?? undefined, crit: c.crit ?? undefined, dir: c.dir, confirm: c.confirm ?? 2, delta: c.delta };
}

/** Membuat paket baru; bila unitnya sudah punya paket, pemeriksaan baru ditambahkan (nama yang sama diganti). */
export async function createCustomPack(b: z.infer<typeof customBody>, actor: string): Promise<CustomPack> {
  const id = packId(b.unit), existing = (await customPacks()).find((p) => p.id === id);
  if (builtinFor(b.unit)) throw bad('Layanan ini sudah punya paket bawaan; pakai paket itu');
  const fresh = b.checks.map(validate), merged = [...(existing?.checks ?? []).filter((c) => !fresh.some((f) => f.name === c.name)), ...fresh];
  if (merged.length > 30) throw bad('Satu layanan maksimal 30 pemeriksaan');
  const pack: CustomPack = { id, unit: b.unit, label: b.label ?? existing?.label ?? b.unit, checks: merged };
  await db().exec('INSERT INTO custom_packs(id,unit,label,checks,created) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT (id) DO UPDATE SET label=$3, checks=$4::jsonb', [pack.id, pack.unit, pack.label, JSON.stringify(pack.checks), Date.now()]);
  await audit(actor, 'standar.layanan.simpan', `${pack.label}: ${fresh.length} pemeriksaan`);
  return pack;
}

export async function removeCustomPack(id: string, actor: string): Promise<void> {
  const p = (await customPacks()).find((x) => x.id === id); if (!p) throw bad('Layanan standar tidak ada');
  await db().exec('DELETE FROM custom_packs WHERE id=$1', [id]); await db().exec('DELETE FROM global_limits WHERE key LIKE $1', [`pack:${id}:%`]);   // pemeriksaan yang sudah terpasang di server tetap jalan dengan nilainya sendiri
  await audit(actor, 'standar.layanan.hapus', p.label);
}

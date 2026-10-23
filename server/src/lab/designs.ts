// Skenario eksperimen yang disimpan (komponen yang ditambahkan + beban), per proyek.
import { bad, db } from '../context.js';
import type { DesignInput } from './types.js';

export interface DesignRow extends DesignInput { id: number; created: number; updated: number }

export async function list(project: string): Promise<DesignRow[]> {
  return db().query<DesignRow>('SELECT id, project, name, actions, load, faults, seconds, failure, created, updated FROM lab_designs WHERE project=$1 ORDER BY updated DESC LIMIT 50', [project]);
}

export async function save(d: DesignInput): Promise<DesignRow> {
  const now = Date.now();
  const existing = await db().one<{ id: number }>('SELECT id FROM lab_designs WHERE project=$1 AND name=$2', [d.project, d.name]);   // nama sama = perbarui
  if (existing) {
    await db().exec('UPDATE lab_designs SET actions=$1, load=$2, faults=$3, seconds=$4, failure=$5, updated=$6 WHERE id=$7', [JSON.stringify(d.actions), JSON.stringify(d.load), d.faults, d.seconds, d.failure ? JSON.stringify(d.failure) : null, now, existing.id]);
    return (await db().one<DesignRow>('SELECT * FROM lab_designs WHERE id=$1', [existing.id]))!;
  }
  const count = (await db().one<{ c: number }>('SELECT COUNT(*)::int AS c FROM lab_designs WHERE project=$1', [d.project]))!.c;
  if (count >= 50) throw bad('Maksimal 50 skenario per proyek. Hapus yang tidak terpakai.');
  return (await db().one<DesignRow>(
    'INSERT INTO lab_designs(project,name,actions,load,faults,seconds,failure,created,updated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *',
    [d.project, d.name, JSON.stringify(d.actions), JSON.stringify(d.load), d.faults, d.seconds, d.failure ? JSON.stringify(d.failure) : null, now]
  ))!;
}

export async function remove(id: number): Promise<void> { await db().exec('DELETE FROM lab_designs WHERE id=$1', [id]); }

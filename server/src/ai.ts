// Pemilihan model untuk fitur analisis (penjelasan hasil, estimasi parameter lab): peran Monitoring dulu, lalu Setup.
import { bad } from './context.js';
import { getRole } from './store.js';

export async function analystRole(): Promise<{ role: 'monitor' | 'setup'; model: string }> {
  for (const role of ['monitor', 'setup'] as const) {
    const r = await getRole(role);
    if (r?.model) return { role, model: r.model };
  }
  throw bad('Atur model untuk peran Monitoring atau Setup di Pengaturan terlebih dulu');
}

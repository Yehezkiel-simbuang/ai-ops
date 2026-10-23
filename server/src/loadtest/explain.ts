// Penjelasan hasil uji beban oleh model. Model hanya boleh menafsirkan angka yang diberikan; analisis deterministik
// (lutut, tahap sehat) tetap sumber kebenaran dan ikut dikirim ke pengguna sebagai pembanding.
import { analystRole } from '../ai.js';
import { bad } from '../context.js';
import { forRole, type RoleChat } from '../llm.js';
import * as Store from './store.js';

const dep: { llm: RoleChat } = { llm: forRole };
export function configure(o: { llm?: RoleChat }): void { if (o.llm) dep.llm = o.llm; }

type Detail = Awaited<ReturnType<typeof Store.get>>;

/** Ringkasan angka yang diberikan ke model: tanpa header, tanpa nilai rahasia. */
export function evidence(t: Detail): string {
  const head = `Target: ${t.target}\nSkenario: ${t.scenario.requests.map((r) => `${r.method} ${r.path} (bobot ${r.weight})`).join(', ')}; jeda ${t.scenario.thinkSeconds} dtk\nKriteria sehat: p95 <= ${t.criteria.p95Ms} ms, error <= ${t.criteria.errPct}%`;
  const rows = t.stages.map((s) => `tahap ${s.idx + 1}: ${s.vus} pengguna, ${s.rps.toFixed(1)} req/dtk, p50 ${Math.round(s.p50)} ms, p95 ${Math.round(s.p95)} ms, p99 ${Math.round(s.p99)} ms, error ${s.errPct.toFixed(1)}%, CPU pembangkit ${Math.round(s.genCpu * 100)}%${s.valid ? '' : ' (TIDAK MURNI)'}${Object.entries(s.scraped).map(([k, v]) => `, ${k} rata-rata ${v.avg.toFixed(1)} puncak ${v.max.toFixed(1)}`).join('')}`);
  return `${head}\n\nHasil per tahap:\n${rows.join('\n')}\n\nAnalisis otomatis: ${t.analysis.verdict.title}. ${t.analysis.verdict.text}`;
}

export async function explain(id: number): Promise<{ text: string; role: string; model: string }> {
  const t = await Store.get(id);
  if (t.status !== 'done' || !t.stages.length) throw bad('Penjelasan hanya tersedia untuk uji yang sudah selesai');
  const { role, model } = await analystRole();
  const r = await dep.llm(role, {
    system: 'Kamu insinyur performa. Bahasa Indonesia, ringkas. Hanya gunakan angka yang diberikan; jangan mengarang metrik, jangan menyebut penyebab pasti bila bukti tidak cukup, dan nyatakan apa yang belum bisa disimpulkan. Tahap bertanda TIDAK MURNI jangan dijadikan bukti kelemahan server.',
    messages: [{ role: 'user', content: `${evidence(t)}\n\nJelaskan: (1) di mana kemungkinan leher botol dan bukti angkanya, (2) seberapa yakin (tinggi/sedang/rendah) beserta alasannya, (3) satu atau dua percobaan lanjutan yang paling berguna.` }],
    maxTokens: 700
  });
  return { text: r.text.trim(), role, model };
}

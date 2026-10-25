// Penjelasan hasil uji beban oleh model. Model hanya boleh menafsirkan angka yang diberikan; analisis deterministik
// (lutut, tahap sehat) tetap sumber kebenaran dan ikut dikirim ke pengguna sebagai pembanding.
import { analystRole } from '../ai.js';
import { bad, db, log } from '../context.js';
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

const running = new Set<Promise<void>>();
/** Untuk uji: tunggu penjelasan di latar belakang selesai. */
export const settled = async (): Promise<void> => { while (running.size) await Promise.all([...running]); };

/** Mulai penjelasan di server dan segera kembali. Hasilnya disimpan di uji itu, jadi tetap selesai walau pengguna pindah halaman atau menutup tab. */
export async function start(id: number): Promise<{ status: 'running' }> {
  const t = await Store.get(id);
  if (t.status !== 'done' || !t.stages.length) throw bad('Penjelasan hanya tersedia untuk uji yang sudah selesai');
  if (t.ai?.status === 'running') return { status: 'running' };   // sudah berjalan: jangan membayar dua kali
  const { role, model } = await analystRole();   // belum ada model = galat langsung ke pengguna, bukan galat yang tersimpan
  await db().exec("UPDATE load_tests SET ai_status='running', ai_error='', ai_ts=$1 WHERE id=$2", [Date.now(), id]);
  const p: Promise<void> = generate(id, t, role, model).finally(() => { running.delete(p); });
  running.add(p);
  return { status: 'running' };
}

async function generate(id: number, t: Detail, role: string, model: string): Promise<void> {
  try {
    const text = await ask(t, role);
    await db().exec("UPDATE load_tests SET ai_status='done', ai_text=$1, ai_model=$2, ai_error='', ai_ts=$3 WHERE id=$4", [text, model, Date.now(), id]);
  } catch (e) {
    log().warn({ err: (e as Error).message, id }, 'penjelasan uji beban gagal');
    await db().exec("UPDATE load_tests SET ai_status='failed', ai_error=$1, ai_ts=$2 WHERE id=$3", [String((e as Error).message).slice(0, 300), Date.now(), id]);
  }
}

async function ask(t: Detail, role: string): Promise<string> {
  const r = await dep.llm(role, {
    system: 'Kamu insinyur performa. Bahasa Indonesia, ringkas. Hanya gunakan angka yang diberikan; jangan mengarang metrik, jangan menyebut penyebab pasti bila bukti tidak cukup, dan nyatakan apa yang belum bisa disimpulkan. Tahap bertanda TIDAK MURNI jangan dijadikan bukti kelemahan server.',
    messages: [{ role: 'user', content: `${evidence(t)}\n\nJelaskan: (1) di mana kemungkinan leher botol dan bukti angkanya, (2) seberapa yakin (tinggi/sedang/rendah) beserta alasannya, (3) satu atau dua percobaan lanjutan yang paling berguna.` }],
    maxTokens: 4000   // model penalaran (mis. gpt-5) memakai anggaran ini juga untuk "berpikir"; 700 membuat jawabannya kosong
  });
  const text = r.text.trim();
  if (!text) throw new Error('Model mengembalikan jawaban kosong (anggaran token bisa habis untuk penalaran). Coba lagi, atau pilih model lain untuk peran ini di Pengaturan.');   // jangan menyimpan yang kosong sebagai "selesai"
  return text;
}

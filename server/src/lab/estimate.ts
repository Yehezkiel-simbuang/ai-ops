// Estimasi parameter lab oleh model. Model membaca potongan berkas konfigurasi proyek (rahasia disamarkan) dan
// mengusulkan nilai untuk parameter yang selama ini hanya tebakan. Server memverifikasi setiap kutipan bukti;
// usulan tanpa bukti yang cocok tetap ditampilkan tetapi keyakinannya dipaksa "rendah". Hasil bukan pengukuran.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { analystRole } from '../ai.js';
import { bad } from '../context.js';
import { forRole, type RoleChat } from '../llm.js';
import { resolveProject } from '../plan.js';
import { getProject } from './service.js';

const dep: { llm: RoleChat } = { llm: forRole };
export function configure(o: { llm?: RoleChat }): void { if (o.llm) dep.llm = o.llm; }

const FOLDER_ID = /^folder:([\w][\w .+\-]{0,100})$/;
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'storage', 'dist', 'build', 'tests', 'test', '.next']);
const WANTED = /^(\.env\.(example|sample)|docker-compose[\w.-]*\.ya?ml|dockerfile|ecosystem\.config\.[cm]?js|package\.json|composer\.json|[\w.-]*(nginx|php-fpm|www|my|mysqld|postgresql|redis|supervisord?)[\w.-]*\.(conf|ini|cnf)|database\.php|queue\.php|cache\.php|session\.php|php\.ini)$/i;
const MAX_FILES = 40, MAX_FILE_BYTES = 12_000, MAX_TOTAL_BYTES = 60_000, MAX_DEPTH = 4;
const SECRET_LINE = /(pass(word|wd)?|secret|token|api[_-]?key|private|dsn|credential|auth)\b[^\n]*[:=]/i;

export interface SourceFile { file: string; lines: string[] }

/** Samarkan nilai rahasia; struktur dan nama kunci dipertahankan agar tetap berguna sebagai bukti. */
export function redact(line: string): string {
  const url = line.replace(/(\w+:\/\/[^:\s/]+:)[^@\s]+@/g, '$1***@');
  return SECRET_LINE.test(url) ? url.replace(/([:=]\s*)(["']?)[^\s"',;]+\2/, '$1***') : url;
}

export function collectFiles(dir: string): SourceFile[] {
  const out: SourceFile[] = []; let total = 0;
  const walk = (d: string, depth: number): void => {
    let entries: string[]; try { entries = readdirSync(d).sort(); } catch { return; }
    for (const name of entries) {
      if (out.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) return;
      const p = join(d, name); let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < MAX_DEPTH && !SKIP_DIRS.has(name)) walk(p, depth + 1); continue; }
      if (!st.isFile() || !WANTED.test(name)) continue;
      let text: string; try { text = readFileSync(p, 'utf8').slice(0, MAX_FILE_BYTES); } catch { continue; }
      if (text.includes('\0')) continue;
      const lines = text.split(/\r?\n/).map(redact);
      total += text.length; out.push({ file: relative(dir, p).replace(/\\/g, '/'), lines });
    }
  };
  walk(dir, 0);
  return out;
}

const answerSchema = z.object({
  estimates: z.array(z.object({
    node: z.string().max(80), key: z.string().max(40), value: z.number(), confidence: z.enum(['tinggi', 'sedang', 'rendah']).catch('rendah'),
    file: z.string().max(300).default(''), line: z.number().int().min(0).default(0), quote: z.string().max(300).default(''), reason: z.string().max(400).default('')
  })).max(40)
});

export interface Estimate {
  node: string; key: string; current: number | string | boolean | null; value: number; confidence: 'tinggi' | 'sedang' | 'rendah';
  verified: boolean; file: string; line: number; quote: string; reason: string;
}
export interface EstimateResult { estimates: Estimate[]; role: string; model: string; filesRead: string[]; assumedCount: number }

/** Bukti sah bila kutipan ada di baris yang disebut (atau satu baris di sekitarnya) pada berkas yang memang dibaca. */
export function verifyQuote(files: SourceFile[], file: string, line: number, quote: string): boolean {
  const f = files.find((x) => x.file === file), q = quote.trim().toLowerCase();
  if (!f || !q || line < 1) return false;
  return [line - 1, line, line + 1].some((n) => f.lines[n - 1]?.toLowerCase().includes(q));
}

export async function estimate(projectId: string): Promise<EstimateResult> {
  const folder = FOLDER_ID.exec(projectId);
  if (!folder) throw bad('Estimasi AI hanya untuk proyek dari folder; contoh bawaan tidak punya kode untuk dibaca');
  const { role, model } = await analystRole();
  const detail = await getProject(projectId), files = collectFiles(resolveProject(folder[1]!));
  if (!files.length) throw bad('Tidak ada berkas konfigurasi yang bisa dibaca di folder proyek ini');
  const nodes = detail.arch.nodes as Array<Record<string, unknown> & { id: string; assumed?: string[] }>;
  const targets = nodes.flatMap((n) => (n.assumed ?? []).map((k) => ({ node: n.id, key: k, current: (n[k] ?? null) as Estimate['current'] })));
  if (!targets.length) return { estimates: [], role, model, filesRead: files.map((f) => f.file), assumedCount: 0 };

  const src = files.map((f) => `### ${f.file}\n${f.lines.map((l, i) => `${i + 1}: ${l}`).join('\n')}`).join('\n\n');
  const r = await dep.llm(role, {
    system: 'Kamu insinyur performa. Kamu hanya boleh mengusulkan nilai bila ada bukti di berkas yang diberikan. Jangan mengarang. Bila tidak ada bukti, jangan sertakan parameter itu. Jawab HANYA JSON.',
    messages: [{ role: 'user', content: `Parameter yang selama ini hanya tebakan:\n${targets.map((t) => `- node "${t.node}", kunci "${t.key}", nilai sekarang ${JSON.stringify(t.current)}`).join('\n')}\n\nBerkas proyek (nomor baris di depan; rahasia sudah disamarkan):\n${src}\n\nBalas JSON: {"estimates":[{"node":"","key":"","value":0,"confidence":"tinggi|sedang|rendah","file":"path persis seperti di atas","line":0,"quote":"potongan teks persis dari baris itu","reason":"alasan singkat"}]}. "tinggi" hanya bila nilainya tertulis langsung; "sedang" bila diturunkan dari beberapa nilai; "rendah" bila perkiraan kasar.` }],
    maxTokens: 1800
  });
  let parsed; try { const t = r.text, a = t.indexOf('{'), b = t.lastIndexOf('}'); parsed = answerSchema.parse(JSON.parse(t.slice(a, b + 1))); } catch { throw bad('Jawaban model tidak bisa dibaca; coba lagi'); }

  const estimates: Estimate[] = [];
  for (const e of parsed.estimates) {
    const t = targets.find((x) => x.node === e.node && x.key === e.key);
    if (!t || !Number.isFinite(e.value) || e.value <= 0 || e.value > 1_000_000) continue;   // hanya parameter tebakan, nilai masuk akal
    const verified = verifyQuote(files, e.file, e.line, e.quote);
    estimates.push({ node: e.node, key: e.key, current: t.current, value: e.value, confidence: verified ? e.confidence : 'rendah', verified, file: e.file, line: e.line, quote: e.quote, reason: e.reason });
  }
  return { estimates, role, model, filesRead: files.map((f) => f.file), assumedCount: targets.length };
}

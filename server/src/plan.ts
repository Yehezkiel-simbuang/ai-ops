// Rencana setup dari analisis kode proyek (analyzer + simulator di folder legacy JS). Hanya membaca, dan hanya di dalam PROJECTS_ROOT.
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, relative, resolve, isAbsolute } from 'node:path';
import { bad, ctx } from './context.js';

export interface Plan { name: string; stack: string; steps: Array<{ title: string; detail: string }> }

export function resolveProject(dir: string): string {
  const root = ctx().cfg.PROJECTS_ROOT;
  if (!root) throw bad('Analisis folder proyek dimatikan. Setel PROJECTS_ROOT (dan pasang folder proyek ke kontainer) untuk mengaktifkannya.');
  const base = realpathSync(resolve(root)), target = resolve(base, dir);
  if (!existsSync(target)) throw bad('Folder proyek tidak ditemukan di dalam PROJECTS_ROOT');
  const real = realpathSync(target), rel = relative(base, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw bad('Folder berada di luar PROJECTS_ROOT');
  return real;
}

export function planFromDir(dir: string): Plan {
  const real = resolveProject(dir), req = createRequire(import.meta.url);
  let pipe: { run: (d: string, o: object) => { facts: { stack: string }; recs: Array<{ optional?: boolean; title: string; why?: string[]; tradeoff: string }> } };
  try { pipe = req(resolve(ctx().cfg.LEGACY_ROOT, 'tools', 'pipeline.js')); } catch (e) { throw bad('Modul analyzer tidak tersedia: ' + (e as Error).message); }
  const r = pipe.run(real, { prove: false, seconds: 30 });
  const steps = [{ title: 'Ukur kondisi server (perintah baca-saja)', detail: 'Ganti asumsi dengan data nyata: pool worker, latensi fsync, processlist, log.' }];
  for (const x of r.recs) steps.push({ title: (x.optional ? '(Opsional) ' : '') + x.title, detail: `${(x.why ?? []).slice(0, 2).join('. ')} Harga: ${x.tradeoff}` });
  steps.push({ title: 'Verifikasi: ulangi pengukuran dan bandingkan dengan sebelum', detail: 'Pastikan tidak ada regresi sebelum menutup proses.' });
  return { name: basename(real), stack: r.facts.stack, steps };
}

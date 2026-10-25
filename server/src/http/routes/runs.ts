// Proses setup oleh agen (LLM): buat, mulai/hentikan, persetujuan perintah, langkah rencana.
import { Router } from 'express';
import { z } from 'zod';
import * as Agent from '../../agent.js';
import { HttpError, bad, db } from '../../context.js';
import { planFromDir } from '../../plan.js';
import * as Servers from '../../servers.js';
import * as Store from '../../store.js';
import { PLACEHOLDER, TEMPLATES } from '../../templates.js';
import { handle, idParam, parse, strParam } from '../handle.js';

const createBody = z.object({
  serverId: z.coerce.number(), name: z.string().optional(), goal: z.string().optional(), template: z.string().nullish(), dir: z.string().optional(),
  maxTurns: z.coerce.number().min(3).max(200).optional(), tokenBudget: z.coerce.number().min(1000).max(5_000_000).optional()
});
const stepBody = z.object({ run: z.string(), step: z.coerce.number(), status: z.string(), note: z.string().nullish() });

/** Susun rencana awal dari templat atau analisis folder proyek. */
function initialPlan(b: z.infer<typeof createBody>) {
  let steps: Array<{ title: string; detail?: string }> = [], name = (b.name ?? '').trim(), goal = (b.goal ?? '').trim(), stack: string | null = null;
  const tpl = b.template ? TEMPLATES.find((t) => t.id === b.template) : undefined;
  if (tpl) { steps = tpl.steps.map((title) => ({ title })); name ||= tpl.name; goal ||= tpl.goal; }
  else if (b.dir) { const plan = planFromDir(b.dir); steps = plan.steps; name ||= plan.name; stack = plan.stack; }
  if (!goal && !steps.length) throw bad('Isi tujuan, pilih templat, atau pilih folder proyek untuk rencana otomatis');
  const open = goal.match(PLACEHOLDER); if (open) throw bad(`Tujuan masih berisi bagian yang harus Anda isi: ${open[0]}. Ganti dengan nilai sebenarnya (atau tulis "tidak ada").`);   // agen tidak boleh menebak domain, kata sandi, atau alamat
  return { steps, name: name || `Setup ${new Date().toLocaleDateString('id-ID')}`, goal: goal || `Terapkan rencana langkah untuk ${stack ?? 'proyek ini'}` };
}

async function runDetail(id: string) {
  const run = await Store.getRun(id); if (!run) throw new HttpError(404, 'Run tidak ada');
  const commands = await db().query('SELECT * FROM commands WHERE run_id=$1 ORDER BY id', [id]);
  const thoughts = (await db().query("SELECT ts, content FROM messages WHERE run_id=$1 AND role='assistant' ORDER BY id", [id])).map((m) => {
    const a = Agent.parseReply(m.content) ?? {};
    return { ts: m.ts, thought: a.thought ?? '', command: a.command ?? '', done: !!a.done, summary: a.summary ?? '' };
  });
  return { run, commands, thoughts };
}

export function runRoutes(): Router {
  const r = Router();
  r.get('/runs', handle(() => Store.runs()));
  r.post('/runs', handle(async (req) => {
    const b = parse(createBody, req.body);
    if (!(await Servers.get(b.serverId))) throw bad('Server tidak ada');
    const plan = initialPlan(b);
    return Store.newRun({ name: plan.name, serverId: b.serverId, goal: plan.goal, dir: b.dir ?? '', steps: plan.steps, maxTurns: b.maxTurns, tokenBudget: b.tokenBudget });
  }));
  r.get('/runs/:id', handle((req) => runDetail(strParam(req))));
  r.delete('/runs/:id', handle(async (req) => { const id = strParam(req); await Agent.stop(id).catch(() => undefined); await Store.deleteRun(id); return { ok: true }; }));
  r.post('/runs/:id/start', handle((req) => Agent.start(strParam(req))));
  r.post('/runs/:id/stop', handle(async (req) => { await Agent.stop(strParam(req)); return { ok: true }; }));
  r.post('/commands/:id/approve', handle((req) => Agent.decide(idParam(req), true)));
  r.post('/commands/:id/reject', handle((req) => Agent.decide(idParam(req), false, parse(z.object({ reason: z.string().max(300).optional() }), req.body).reason)));
  r.post('/steps', handle((req) => { const b = parse(stepBody, req.body); return Store.setStep(b.run, b.step, b.status, b.note); }));
  return r;
}

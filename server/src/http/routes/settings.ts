// Pengaturan: penyedia model + API key, peran, harga, uji panggilan, pemakaian token, preferensi, jejak audit, templat.
import { Router } from 'express';
import { z } from 'zod';
import { db, metaGet, metaSet } from '../../context.js';
import * as LLM from '../../llm.js';
import * as Store from '../../store.js';
import { TEMPLATES } from '../../templates.js';
import { handle, parse, strParam } from '../handle.js';

const providerBody = z.object({ id: z.string(), label: z.string().optional(), type: z.string().optional(), baseUrl: z.string().optional(), apiKey: z.string().optional(), keyless: z.boolean().optional() });
const roleBody = z.object({ role: z.string(), provider: z.string(), model: z.string() });
const priceBody = z.object({ provider: z.string(), model: z.string(), in: z.union([z.string(), z.number(), z.null()]).optional(), out: z.union([z.string(), z.number(), z.null()]).optional() });
const settingsBody = z.object({
  auto_report: z.boolean().optional(), reminder_min: z.coerce.number().optional(), notify_runs: z.boolean().optional(),
  digest_enabled: z.boolean().optional(), digest_hour: z.coerce.number().int().min(0).max(23).optional(),
  quiet_on: z.boolean().optional(), quiet_start: z.coerce.number().int().min(0).max(23).optional(), quiet_end: z.coerce.number().int().min(0).max(23).optional()
});

const flag = (v: boolean) => (v ? '1' : '0');

async function readSettings() {
  return {
    auto_report: (await metaGet('auto_report')) === '1', reminder_min: Number((await metaGet('reminder_min')) ?? 60), notify_runs: (await metaGet('notify_runs')) !== '0',
    digest_enabled: (await metaGet('digest_enabled')) !== '0', digest_hour: Number((await metaGet('digest_hour')) ?? 8),
    quiet_on: (await metaGet('quiet_on')) === '1', quiet_start: Number((await metaGet('quiet_start')) ?? 22), quiet_end: Number((await metaGet('quiet_end')) ?? 7)
  };
}

async function saveSettings(b: z.infer<typeof settingsBody>): Promise<void> {
  if (b.digest_enabled != null) await metaSet('digest_enabled', flag(b.digest_enabled));
  if (b.digest_hour != null) await metaSet('digest_hour', String(b.digest_hour));
  if (b.quiet_on != null) await metaSet('quiet_on', flag(b.quiet_on));
  if (b.quiet_start != null) await metaSet('quiet_start', String(b.quiet_start));
  if (b.quiet_end != null) await metaSet('quiet_end', String(b.quiet_end));
  if (b.auto_report != null) await metaSet('auto_report', flag(b.auto_report));
  if (b.reminder_min != null) await metaSet('reminder_min', String(Math.max(0, Math.min(1440, b.reminder_min || 0))));
  if (b.notify_runs != null) await metaSet('notify_runs', flag(b.notify_runs));
}

export function settingsRoutes(): Router {
  const r = Router();
  r.get('/config', handle(() => Store.publicConfig()));
  r.post('/provider', handle(async (req) => { const b = parse(providerBody, req.body); await Store.upsertProvider(b.id, b); return { ok: true }; }));
  r.delete('/provider/:id', handle(async (req) => { await Store.removeProvider(strParam(req)); return { ok: true }; }));
  r.post('/models', handle(async (req) => ({ models: await LLM.listModels(parse(z.object({ id: z.string() }), req.body).id) })));
  r.post('/role', handle(async (req) => { const b = parse(roleBody, req.body); await Store.setRole(b.role, b.provider, b.model); return { ok: true }; }));
  r.post('/price', handle(async (req) => { const b = parse(priceBody, req.body); await Store.setPrice(b.provider, b.model, b.in === '' ? null : b.in, b.out === '' ? null : b.out); return { ok: true }; }));
  r.post('/test', handle(async (req) => {
    const b = parse(z.object({ role: z.string() }), req.body), t0 = Date.now();
    const out = await LLM.forRole(b.role, { maxTokens: 40, messages: [{ role: 'user', content: 'Balas satu kata saja: siap' }] });
    return { text: out.text.slice(0, 200), usage: out.usage, ms: Date.now() - t0 };
  }));
  r.get('/usage', handle((req) => Store.summary(Math.min(365, Number(req.query.days) || 30))));
  r.get('/settings', handle(readSettings));
  r.post('/settings', handle(async (req) => { await saveSettings(parse(settingsBody, req.body)); return { ok: true }; }));
  r.get('/audit', handle(() => db().query('SELECT * FROM audit ORDER BY id DESC LIMIT 100')));
  r.get('/templates', handle(() => TEMPLATES));
  return r;
}

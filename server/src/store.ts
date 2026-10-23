// Akses data penyedia model, peran, harga, pemakaian token, dan rencana setup. API key tidak keluar dari modul ini
// kecuali lewat secret() untuk memanggil penyedia.
import { audit, bad, db } from './context.js';
import { open, seal } from './crypto.js';

export interface Preset { id: string; label: string; type: 'anthropic' | 'openai' | 'google'; baseUrl: string; keyless?: boolean }
export const PRESETS: Preset[] = [
  { id: 'anthropic', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'google', label: 'Google Gemini', type: 'google', baseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'openrouter', label: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek', label: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com' },
  { id: 'groq', label: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'xai', label: 'xAI', type: 'openai', baseUrl: 'https://api.x.ai/v1' },
  { id: 'mistral', label: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'ollama', label: 'Ollama (lokal)', type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', keyless: true }
];
export const ROLES = ['setup', 'monitor'] as const;
export type Role = (typeof ROLES)[number];
const mask = (k: string): string => (k ? '****' + k.slice(-4) : '');

export async function publicConfig() {
  const providers: Record<string, unknown> = {}, roles: Record<string, unknown> = {}, prices: Record<string, unknown> = {};
  for (const p of await db().query('SELECT * FROM providers ORDER BY id')) { const k = open(p.api_key_enc); providers[p.id] = { id: p.id, label: p.label, type: p.type, baseUrl: p.base_url, keyless: p.keyless, hasKey: !!k, keyHint: mask(k) }; }
  for (const r of await db().query('SELECT * FROM roles')) roles[r.role] = { provider: r.provider, model: r.model };
  for (const p of await db().query('SELECT * FROM prices')) prices[p.key] = { in: p.in_price, out: p.out_price };
  return { providers, roles, prices, presets: PRESETS };
}

export interface ProviderInput { label?: string; type?: string; baseUrl?: string; apiKey?: string; keyless?: boolean }
export async function upsertProvider(id: string, b: ProviderInput): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw bad('ID penyedia tidak valid');
  const old = await db().one('SELECT * FROM providers WHERE id=$1', [id]), preset = PRESETS.find((p) => p.id === id);
  const type = b.type || old?.type || preset?.type || 'openai', base = String(b.baseUrl || old?.base_url || preset?.baseUrl || '').replace(/\/+$/, '');
  if (!['anthropic', 'openai', 'google'].includes(type)) throw bad('Jenis API tidak dikenal');
  if (!/^https?:\/\//.test(base)) throw bad('Base URL harus diawali http:// atau https://');
  const keyless = b.keyless != null ? !!b.keyless : old ? !!old.keyless : !!preset?.keyless;
  const keyEnc = b.apiKey ? seal(String(b.apiKey).trim()) : old ? old.api_key_enc : '';
  await db().exec(`INSERT INTO providers(id,label,type,base_url,keyless,api_key_enc) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,type=EXCLUDED.type,base_url=EXCLUDED.base_url,keyless=EXCLUDED.keyless,api_key_enc=EXCLUDED.api_key_enc`,
    [id, b.label || old?.label || preset?.label || id, type, base, keyless, keyEnc]);
  await audit('pengguna', 'provider.simpan', id);
}
export async function removeProvider(id: string): Promise<void> { await db().exec('DELETE FROM providers WHERE id=$1', [id]); await audit('pengguna', 'provider.hapus', id); }
export async function setRole(role: string, provider: string, model: string): Promise<void> {
  if (!ROLES.includes(role as Role)) throw bad('Peran tidak dikenal');
  if (!(await db().one('SELECT 1 AS x FROM providers WHERE id=$1', [provider]))) throw bad('Penyedia belum ditambahkan');
  if (!String(model || '').trim()) throw bad('Model wajib diisi');
  await db().exec('INSERT INTO roles(role,provider,model) VALUES($1,$2,$3) ON CONFLICT(role) DO UPDATE SET provider=EXCLUDED.provider,model=EXCLUDED.model', [role, provider, String(model).trim()]);
  await audit('pengguna', 'peran.atur', `${role} -> ${provider}/${model}`);
}
export async function getRole(role: string): Promise<{ provider: string; model: string } | null> { const r = await db().one('SELECT provider, model FROM roles WHERE role=$1', [role]); return r ? { provider: r.provider, model: r.model } : null; }
export async function setPrice(provider: string, model: string, pin: unknown, pout: unknown): Promise<void> {
  const k = `${provider}/${model}`;
  if (pin == null && pout == null) await db().exec('DELETE FROM prices WHERE key=$1', [k]);
  else await db().exec('INSERT INTO prices(key,in_price,out_price) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET in_price=EXCLUDED.in_price,out_price=EXCLUDED.out_price', [k, Number(pin) || 0, Number(pout) || 0]);
}
export interface ProviderSecret { label: string; type: 'anthropic' | 'openai' | 'google'; baseUrl: string; keyless: boolean; apiKey: string }
export async function secret(id: string): Promise<ProviderSecret | null> { const p = await db().one('SELECT * FROM providers WHERE id=$1', [id]); return p ? { label: p.label, type: p.type, baseUrl: p.base_url, keyless: p.keyless, apiKey: open(p.api_key_enc) } : null; }

// ---------- pemakaian token
export interface UsageRec { role?: string; provider: string; model: string; input: number; output: number; run?: string | null }
export async function addUsage(r: UsageRec): Promise<void> { await db().exec('INSERT INTO usage(ts,role,provider,model,input,output,run_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [Date.now(), r.role || '-', r.provider, r.model, r.input || 0, r.output || 0, r.run || null]); }
interface Agg { input: number; output: number; calls: number; cost: number; costKnown: boolean }
export async function summary(days: number) {
  const since = Date.now() - days * 864e5, cfg = await publicConfig(), prices = cfg.prices as Record<string, { in: number; out: number }>;
  const rows = await db().query('SELECT * FROM usage WHERE ts>=$1 ORDER BY ts', [since]);
  const costOf = (r: Record<string, any>): number | null => { const p = prices[`${r.provider}/${r.model}`]; return p ? (r.input * p.in + r.output * p.out) / 1e6 : null; };
  const by = { role: {} as Record<string, Agg>, model: {} as Record<string, Agg>, day: {} as Record<string, Agg> }, tot: Agg = { input: 0, output: 0, calls: 0, cost: 0, costKnown: true };
  const add = (o: Agg, r: { input: number; output: number }, cost: number | null) => { o.input += r.input; o.output += r.output; o.calls++; if (cost == null) o.costKnown = false; else o.cost += cost; };
  for (const r of rows) {
    const cost = costOf(r), day = new Date(Number(r.ts)).toISOString().slice(0, 10);
    for (const [k, key] of [['role', r.role || '-'], ['model', `${r.provider}/${r.model}`], ['day', day]] as const) add((by[k][key] ??= { input: 0, output: 0, calls: 0, cost: 0, costKnown: true }), r as never, cost);
    add(tot, r as never, cost);
  }
  return { days, total: tot, byRole: by.role, byModel: by.model, byDay: by.day, recent: rows.slice(-12).reverse().map((r) => ({ ts: r.ts, role: r.role, provider: r.provider, model: r.model, input: r.input, output: r.output, run: r.run_id, cost: costOf(r as never) })) };
}
export async function runTokens(runId: string): Promise<number> { const r = await db().one('SELECT COALESCE(SUM(input+output),0) AS t FROM usage WHERE run_id=$1', [runId]); return Number(r?.t ?? 0); }

// ---------- rencana setup
export async function stepsOf(runId: string) { return db().query('SELECT n AS id, title, detail, status, note FROM steps WHERE run_id=$1 ORDER BY n', [runId]); }
export type RunRow = Record<string, any> & { steps: Array<Record<string, any>>; tokens: number };
async function withExtras(r: Record<string, any> | undefined): Promise<RunRow | undefined> { return r ? ({ ...r, steps: await stepsOf(r.id), tokens: await runTokens(r.id) } as RunRow) : undefined; }
export async function runs() { const rows = await db().query('SELECT r.*, s.name AS server_name FROM runs r LEFT JOIN servers s ON s.id=r.server_id ORDER BY r.created DESC LIMIT 50'); return Promise.all(rows.map((r) => withExtras(r) as Promise<RunRow>)); }
export async function getRun(id: string) { return withExtras(await db().one('SELECT r.*, s.name AS server_name FROM runs r LEFT JOIN servers s ON s.id=r.server_id WHERE r.id=$1', [id])); }
export interface NewRun { name: string; serverId?: number | null; goal?: string; dir?: string; steps?: Array<{ title: string; detail?: string }>; maxTurns?: number; tokenBudget?: number }
export async function newRun(o: NewRun) {
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), now = Date.now();
  await db().tx(async (t) => {
    await t.exec('INSERT INTO runs(id,name,server_id,goal,dir,status,created,updated,max_turns,token_budget) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, o.name, o.serverId ?? null, o.goal || '', o.dir || '', 'draft', now, now, o.maxTurns || 30, o.tokenBudget || 200000]);
    let i = 0; for (const s of o.steps || []) await t.exec('INSERT INTO steps(run_id,n,title,detail) VALUES($1,$2,$3,$4)', [id, ++i, s.title, s.detail || '']);
  });
  await audit('pengguna', 'run.buat', `${id} ${o.name}`); return (await getRun(id))!;
}
export async function setStep(runId: string, n: number, status: string, note?: string | null) {
  if (!['pending', 'running', 'done', 'failed', 'skipped'].includes(status)) throw bad('Status tidak dikenal');
  const c = await db().exec('UPDATE steps SET status=$1, note=COALESCE($2,note) WHERE run_id=$3 AND n=$4', [status, note == null ? null : String(note).slice(0, 500), runId, Number(n)]);
  if (!c) throw bad('Langkah tidak ada');
  await db().exec('UPDATE runs SET updated=$1 WHERE id=$2', [Date.now(), runId]); return getRun(runId);
}
export async function deleteRun(id: string): Promise<void> { await db().exec('DELETE FROM runs WHERE id=$1', [id]); await audit('pengguna', 'run.hapus', id); }

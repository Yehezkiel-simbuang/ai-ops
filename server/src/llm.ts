// Lapisan model multi-penyedia. Tiga bentuk API: anthropic, openai (kompatibel: OpenRouter, DeepSeek, Groq, xAI, Mistral, Ollama, dst.), google.
// Setiap panggilan mengembalikan { text, usage } dan dicatat ke ledger dengan peran (setup/monitor).
import { bad, HttpError } from './context.js';
import { addUsage, getRole, secret, type ProviderSecret } from './store.js';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatRequest { role?: string; provider: string; model: string; system?: string; messages: ChatMessage[]; maxTokens?: number; run?: string | null }
export interface ChatResult { text: string; usage: { input: number; output: number } }
export type RoleChat = (role: string, req: { system?: string; messages: ChatMessage[]; maxTokens?: number; run?: string | null }) => Promise<ChatResult>;

async function http(url: string, init: RequestInit, timeoutMs = 60_000): Promise<any> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal }), txt = await res.text(); let j: any = null; try { j = JSON.parse(txt); } catch { /* bukan JSON */ }
    if (!res.ok) { const m = j?.error?.message ?? j?.error ?? j?.message ?? txt.slice(0, 200); throw new HttpError(502, `Penyedia membalas HTTP ${res.status}: ${(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 300)}`); }
    return j;
  } catch (e) { if ((e as Error).name === 'AbortError') throw new HttpError(504, `Penyedia tidak menjawab dalam ${Math.round(timeoutMs / 1000)} detik`); if (e instanceof HttpError) throw e; throw new HttpError(502, `Tidak bisa menghubungi penyedia: ${(e as Error).message}`); }
  finally { clearTimeout(t); }
}
async function need(id: string): Promise<ProviderSecret> {
  const p = await secret(id); if (!p) throw bad('Penyedia belum ditambahkan'); if (!p.keyless && !p.apiKey) throw bad('API key belum diisi'); return p;
}

export async function listModels(id: string): Promise<string[]> {
  const p = await need(id);
  if (p.type === 'anthropic') { const j = await http(`${p.baseUrl}/v1/models?limit=100`, { headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' } }, 20_000); return (j.data ?? []).map((m: any) => m.id); }
  if (p.type === 'google') { const j = await http(`${p.baseUrl}/v1beta/models?pageSize=100`, { headers: { 'x-goog-api-key': p.apiKey } }, 20_000); return (j.models ?? []).filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m: any) => String(m.name).replace(/^models\//, '')); }
  const j = await http(`${p.baseUrl}/models`, { headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {} }, 20_000);
  return (j.data ?? []).map((m: any) => m.id).sort();
}

export async function chat(o: ChatRequest): Promise<ChatResult> {
  const p = await need(o.provider), max = o.maxTokens ?? 1024, msgs = o.messages ?? []; let text = '', input = 0, output = 0, j: any;
  if (p.type === 'anthropic') {
    j = await http(`${p.baseUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: o.model, max_tokens: max, system: o.system || undefined, messages: msgs }) });
    text = (j.content ?? []).map((b: any) => b.text ?? '').join(''); input = j.usage?.input_tokens ?? 0; output = j.usage?.output_tokens ?? 0;
  } else if (p.type === 'google') {
    j = await http(`${p.baseUrl}/v1beta/models/${encodeURIComponent(o.model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': p.apiKey },
      body: JSON.stringify({ systemInstruction: o.system ? { parts: [{ text: o.system }] } : undefined, contents: msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: max } }) });
    text = (j.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? '').join(''); input = j.usageMetadata?.promptTokenCount ?? 0; output = j.usageMetadata?.candidatesTokenCount ?? 0;
  } else {
    const body: Record<string, unknown> = { model: o.model, messages: [...(o.system ? [{ role: 'system', content: o.system }] : []), ...msgs] };
    body[o.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = max;
    j = await http(`${p.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) }, body: JSON.stringify(body) });
    text = j.choices?.[0]?.message?.content ?? ''; input = j.usage?.prompt_tokens ?? 0; output = j.usage?.completion_tokens ?? 0;
  }
  await addUsage({ role: o.role || '-', provider: o.provider, model: o.model, input, output, run: o.run ?? null });
  return { text, usage: { input, output } };
}

// pakai model sesuai peran yang diatur pengguna
export const forRole: RoleChat = async (role, req) => {
  const r = await getRole(role); if (!r?.model) throw bad(`Peran "${role}" belum diatur`);
  return chat({ ...req, role, provider: r.provider, model: r.model });
};

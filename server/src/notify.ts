// Notifikasi ke Anda: Telegram, ntfy (push ke ponsel), webhook (Slack/Discord/umum), dan email (SMTP).
// Konfigurasi kanal dienkripsi di database. Setiap pengiriman dicatat. Tanpa dependensi.
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { audit, bad, db, log, metaGet } from './context.js';
import { open, seal } from './crypto.js';

export const LEVELS: Record<string, number> = { semua: 1, peringatan: 2, kritis: 3 };
type Cfg = Record<string, string>;
const FIELDS: Record<string, string[]> = { telegram: ['token', 'chatId', 'apiBase'], ntfy: ['url', 'topic', 'token'], webhook: ['url', 'format'], email: ['host', 'port', 'secure', 'user', 'pass', 'from', 'to'] };
const SECRET: Record<string, string[]> = { telegram: ['token'], ntfy: ['token'], webhook: ['url'], email: ['pass'] };
export interface Message { kind: string; level: 'kritis' | 'peringatan' | 'pulih' | 'info'; importance: number; title: string; text: string }

function clean(type: string, c: Record<string, unknown>): Cfg {
  if (!FIELDS[type]) throw bad('Jenis kanal tidak dikenal');
  const o: Cfg = {}; for (const k of FIELDS[type]!) if (c[k] != null && String(c[k]).trim() !== '') o[k] = String(c[k]).trim();
  if (type === 'telegram' && (!o.token || !o.chatId)) throw bad('Token bot dan chat ID wajib');
  if (type === 'ntfy') { o.url = (o.url || 'https://ntfy.sh').replace(/\/+$/, ''); if (!/^https?:\/\//.test(o.url)) throw bad('URL ntfy tidak valid'); if (!/^[A-Za-z0-9_-]{3,64}$/.test(o.topic || '')) throw bad('Topik ntfy 3-64 karakter (huruf, angka, - _). Pakai nama yang sulit ditebak.'); }
  if (type === 'webhook') { if (!/^https?:\/\//.test(o.url || '')) throw bad('URL webhook tidak valid'); o.format = ['generic', 'slack', 'discord'].includes(o.format ?? '') ? o.format! : 'generic'; }
  if (type === 'email') {
    for (const k of ['host', 'from', 'to']) if (!o[k]) throw bad(`Email: ${k} wajib`);
    o.port = o.port || '587'; o.secure = ['tls', 'starttls', 'none'].includes(o.secure ?? '') ? o.secure! : 'starttls';
    if (!/^[^\s@]+@[^\s@]+$/.test(o.from!)) throw bad('Alamat pengirim tidak valid'); if (!o.to!.split(',').every((x) => /^[^\s@]+@[^\s@]+$/.test(x.trim()))) throw bad('Alamat tujuan tidak valid');
  }
  return o;
}
const cfgOf = (row: Record<string, any>): Cfg => JSON.parse(open(row.config_enc) || '{}');
function view(row: Record<string, any>) {
  const c = cfgOf(row), pub: Cfg = {}; for (const k of Object.keys(c)) pub[k] = (SECRET[row.type] ?? []).includes(k) ? '****' + String(c[k]).slice(-3) : c[k]!;
  return { id: row.id, type: row.type, name: row.name, enabled: row.enabled, min_level: row.min_level, config: pub };
}
export async function list() { return (await db().query('SELECT * FROM channels ORDER BY id')).map(view); }
export async function save(b: { type?: string; name?: string; config?: Record<string, unknown>; min_level?: string; enabled?: boolean }, id?: number | string) {
  const old = id ? await db().one('SELECT * FROM channels WHERE id=$1', [Number(id)]) : undefined; if (id && !old) throw bad('Kanal tidak ada');
  const type = old ? old.type : String(b.type || ''), prev = old ? cfgOf(old) : {}, incoming: Record<string, unknown> = { ...(b.config ?? {}) };
  for (const k of SECRET[type] ?? []) if (!incoming[k] && prev[k]) incoming[k] = prev[k];   // kosong = pertahankan rahasia lama
  const cfg = clean(type, incoming), name = String(b.name || '').trim() || type, ml = b.min_level && LEVELS[b.min_level] ? b.min_level : old ? old.min_level : 'kritis';
  if (old) await db().exec('UPDATE channels SET name=$1, config_enc=$2, enabled=$3, min_level=$4 WHERE id=$5', [name, seal(JSON.stringify(cfg)), b.enabled !== false, ml, old.id]);
  else await db().exec('INSERT INTO channels(type,name,config_enc,enabled,min_level,created) VALUES($1,$2,$3,$4,$5,$6)', [type, name, seal(JSON.stringify(cfg)), true, ml, Date.now()]);
  await audit('pengguna', old ? 'kanal.ubah' : 'kanal.tambah', `${type} ${name}`); return list();
}
export async function remove(id: number | string): Promise<void> { await db().exec('DELETE FROM channels WHERE id=$1', [Number(id)]); await audit('pengguna', 'kanal.hapus', String(id)); }

// ---------- pengiriman per jenis
async function post(url: string, init: RequestInit, ms = 15_000): Promise<void> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { ...init, signal: ctl.signal }); if (!r.ok) { const b = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status} ${b.slice(0, 150)}`); } }
  catch (e) { throw new Error((e as Error).name === 'AbortError' ? 'waktu habis' : (e as Error).message); } finally { clearTimeout(t); }
}
const ICON = { kritis: '[KRITIS]', peringatan: '[PERINGATAN]', pulih: '[PULIH]', info: '[INFO]' };
const sendTelegram = (c: Cfg, m: Message) => post(`${c.apiBase || 'https://api.telegram.org'}/bot${c.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: c.chatId, text: `${m.title}\n${m.text}`, disable_web_page_preview: true }) });
const sendNtfy = (c: Cfg, m: Message) => post(`${c.url}/${c.topic}`, { method: 'POST', headers: { Title: encodeURIComponent(m.title).replace(/%20/g, ' ').slice(0, 250), Priority: m.level === 'kritis' ? '5' : m.level === 'peringatan' ? '4' : '3', Tags: m.level === 'pulih' ? 'white_check_mark' : m.level === 'kritis' ? 'rotating_light' : 'warning', ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) }, body: m.text });
function sendWebhook(c: Cfg, m: Message): Promise<void> {
  const text = `${m.title}\n${m.text}`, body = c.format === 'slack' ? { text } : c.format === 'discord' ? { content: text.slice(0, 1900) } : { title: m.title, text: m.text, level: m.level, kind: m.kind, ts: new Date().toISOString() };
  return post(c.url!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

// SMTP minimal: TLS langsung (465), STARTTLS (587), atau polos (relay lokal). AUTH PLAIN bila user diisi.
export function smtp(c: Cfg, subject: string, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let sock!: net.Socket, buf = '', acc: string[] = [], waiting: ((r: { code: number; text: string }) => void) | null = null, done = false; const ready: Array<{ code: number; text: string }> = [];
    const fail = (e: unknown) => { if (done) return; done = true; try { sock?.destroy(); } catch { /* abaikan */ } reject(e instanceof Error ? e : new Error(String(e))); };
    const ok = () => { if (done) return; done = true; try { sock.end(); } catch { /* abaikan */ } resolve(); };
    const timer = setTimeout(() => fail(new Error('SMTP waktu habis')), 25_000);
    const onData = (d: string) => {
      buf += d; const lines = buf.split('\r\n'); buf = lines.pop() ?? '';
      for (const l of lines) { acc.push(l); if (/^\d{3} /.test(l)) { const r = { code: Number(l.slice(0, 3)), text: acc.join(' | ') }; acc = []; if (waiting) { const w = waiting; waiting = null; w(r); } else ready.push(r); } }
    };
    const read = () => new Promise<{ code: number; text: string }>((res) => { const r = ready.shift(); if (r) res(r); else waiting = res; });
    const cmd = async (line: string, expect: number[]) => { sock.write(line + '\r\n'); const r = await read(); if (!expect.includes(r.code)) throw new Error('SMTP: ' + r.text.slice(0, 160)); return r; };
    const attach = (s: net.Socket) => { sock = s; s.setEncoding('utf8'); s.on('data', onData); s.on('error', fail); };
    const port = Number(c.port || 587), host = c.host!;
    void (async () => {
      try {
        await new Promise<void>((res, rej) => { const s: net.Socket = c.secure === 'tls' ? tls.connect({ host, port, servername: host }, () => res()) : net.connect({ host, port }, () => res()); s.once('error', rej); attach(s); });
        const g = await read(); if (g.code !== 220) throw new Error('SMTP sapaan: ' + g.text);
        const me = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
        await cmd('EHLO ' + me, [250]);
        if (c.secure === 'starttls') { await cmd('STARTTLS', [220]); sock.removeAllListeners('data'); const raw = sock; await new Promise<void>((res, rej) => { const s2 = tls.connect({ socket: raw, servername: host }, () => res()); s2.once('error', rej); attach(s2); }); buf = ''; await cmd('EHLO ' + me, [250]); }
        if (c.user) await cmd('AUTH PLAIN ' + Buffer.from('\0' + c.user + '\0' + (c.pass || '')).toString('base64'), [235]);
        await cmd(`MAIL FROM:<${c.from}>`, [250]);
        const to = c.to!.split(',').map((x) => x.trim()).filter(Boolean); for (const t of to) await cmd(`RCPT TO:<${t}>`, [250, 251]);
        await cmd('DATA', [354]);
        const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
        const msg = [`From: ${c.from}`, `To: ${to.join(', ')}`, `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
        sock.write(msg.replace(/^\./gm, '..') + '\r\n.\r\n'); const r = await read(); if (r.code !== 250) throw new Error('SMTP DATA: ' + r.text.slice(0, 160));
        try { sock.write('QUIT\r\n'); } catch { /* abaikan */ }
        clearTimeout(timer); ok();
      } catch (e) { clearTimeout(timer); fail(e); }
    })();
  });
}
const SENDERS: Record<string, (c: Cfg, m: Message) => Promise<void>> = { telegram: sendTelegram, ntfy: sendNtfy, webhook: sendWebhook, email: (c, m) => smtp(c, m.title, m.text) };

async function record(row: Record<string, any>, kind: string, title: string, ok: boolean, err = ''): Promise<void> {
  await db().exec('INSERT INTO notifications(ts,channel_id,channel_name,kind,title,ok,error) VALUES($1,$2,$3,$4,$5,$6,$7)', [Date.now(), row.id, row.name, kind, String(title).slice(0, 200), ok, String(err).slice(0, 300)]);
}
async function sendTo(row: Record<string, any>, m: Message): Promise<{ ok: boolean; error?: string }> {
  try { await SENDERS[row.type]!(cfgOf(row), m); await record(row, m.kind, m.title, true); return { ok: true }; }
  catch (e) { await record(row, m.kind, m.title, false, (e as Error).message); return { ok: false, error: (e as Error).message }; }
}
export async function test(id: number | string) {
  const row = await db().one('SELECT * FROM channels WHERE id=$1', [Number(id)]); if (!row) throw bad('Kanal tidak ada');
  return sendTo(row, { kind: 'uji', level: 'info', importance: 1, title: '[UJI] AI Ops', text: `Notifikasi uji berhasil sampai. Jika kamu membaca ini, kanal "${row.name}" berfungsi.` });
}
export async function dispatch(m: Message) {
  const rows = await db().query('SELECT * FROM channels WHERE enabled'), out: Array<{ ok: boolean; error?: string }> = [];
  for (const row of rows) { if ((LEVELS[row.min_level] ?? 3) > m.importance) continue; out.push(await sendTo(row, m)); }
  return out;
}
const fire = (p: Promise<unknown>): void => { p.catch((e) => log().warn({ err: (e as Error).message }, 'notifikasi gagal')); };

// ---------- peristiwa
interface AlertLike { id?: number; level: string; title: string; detail: string; source?: string; notified_ts?: number | null }
function alertMessage(a: AlertLike, serverName: string, phase: 'baru' | 'pulih' | 'ulang'): Message {
  if (phase === 'pulih') return { kind: 'alert', level: 'pulih', importance: a.level === 'kritis' ? 3 : 2, title: `${ICON.pulih} ${serverName}: ${a.title}`, text: 'Kembali normal. ' + (a.detail || '') };
  const lv = a.level === 'kritis' ? 'kritis' : 'peringatan';
  return { kind: 'alert', level: lv, importance: a.level === 'kritis' ? 3 : 2, title: `${ICON[lv]} ${serverName}: ${a.title}${phase === 'ulang' ? ' (pengingat)' : ''}`, text: `${a.detail || ''}\nSumber: ${a.source === 'service' ? 'pemeriksaan layanan' : a.source === 'agent' ? 'agen di server' : 'resource'}. Buka AI Ops untuk detail.` };
}
export function alertOpened(a: AlertLike, serverName: string): void { fire((async () => { if (a.id) await db().exec('UPDATE alerts SET notified_ts=$1 WHERE id=$2', [Date.now(), a.id]); await dispatch(alertMessage(a, serverName, 'baru')); })()); }
export function alertResolved(a: AlertLike, serverName: string): void { if (a.notified_ts) fire(dispatch(alertMessage(a, serverName, 'pulih'))); }
export async function reminders(): Promise<void> {
  const every = Number((await metaGet('reminder_min')) ?? 60) * 60_000; if (!(every > 0)) return;
  // UPDATE ... RETURNING mengklaim baris secara atomik, jadi pengingat tidak ganda walau pemeriksaan berjalan bersamaan
  const due = await db().query("UPDATE alerts a SET notified_ts=$1 FROM servers s WHERE s.id=a.server_id AND NOT a.resolved AND NOT a.acked AND a.level='kritis' AND a.notified_ts IS NOT NULL AND a.notified_ts<$2 RETURNING a.*, s.name AS sname", [Date.now(), Date.now() - every]);
  for (const a of due) fire(dispatch(alertMessage(a as AlertLike, a.sname, 'ulang')));
}
export function approvalPending(cmd: { command: string }, runName: string, serverName: string): void {
  fire(dispatch({ kind: 'approval', level: 'info', importance: 3, title: `[PERSETUJUAN] ${runName || 'Setup'} di ${serverName || 'server'}`, text: `Agen meminta izin menjalankan:\n${String(cmd.command).slice(0, 400)}\nBuka AI Ops > Ringkasan untuk menyetujui atau menolak.` }));
}
export async function runFinished(run: { name: string; status: string; summary?: string }): Promise<void> {
  if ((await metaGet('notify_runs')) === '0') return;
  const badRun = run.status === 'failed'; fire(dispatch({ kind: 'run', level: badRun ? 'peringatan' : 'info', importance: badRun ? 3 : 2, title: `${badRun ? '[GAGAL]' : '[SELESAI]'} ${run.name}`, text: String(run.summary ?? '').slice(0, 600) }));
}
export function recommendationReady(serverName: string, title: string, diagnosis: string, source: string): void {
  fire(dispatch({ kind: 'recommendation', level: 'info', importance: 3, title: `[REKOMENDASI] ${serverName}: ${title}`, text: `${diagnosis.slice(0, 500)}\n(${source === 'llm' ? 'disusun model' : 'playbook'}) Buka AI Ops > Insiden untuk meninjau dan menyetujui.` }));
}
export function recommendationResult(serverName: string, recId: number, ok: boolean, text: string): void {
  fire(dispatch({ kind: 'recommendation', level: ok ? 'info' : 'peringatan', importance: ok ? 2 : 3, title: `${ok ? '[SELESAI]' : '[GAGAL]'} Perbaikan #${recId} di ${serverName}`, text }));
}
export async function history() { return db().query('SELECT * FROM notifications ORDER BY id DESC LIMIT 30'); }

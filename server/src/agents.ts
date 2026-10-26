// Agen di server: kredensial per server, verifikasi tanda tangan HMAC, detak jantung, antrean perintah bertanda tangan untuk agen,
// dan pengawas "agen mati". Agen hanya MENDORONG kejadian kritis; perintah hanya dijalankan agen bila sudah disetujui pengguna.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { audit, bad, db } from './context.js';
import { open, randomToken, seal } from './crypto.js';
import { syncAlerts } from './monitor.js';
import { redactOutput } from './redact.js';

export interface AgentRow { server_id: number; key_id: string; secret_enc: string; created: number; rotated: number | null; last_seen: number | null; version: string; hostname: string; exec_enabled: boolean; open_keys: string[]; online: boolean; last_ip: string }
export const MAX_SKEW_MS = 5 * 60_000;

// ---------- kredensial
export async function issue(serverId: number): Promise<{ keyId: string; secret: string; rotated: boolean }> {
  if (!(await db().one('SELECT 1 AS x FROM servers WHERE id=$1', [serverId]))) throw bad('Server tidak ada');
  const old = await db().one('SELECT key_id FROM agents WHERE server_id=$1', [serverId]);
  const keyId = old?.key_id ?? 'ak_' + randomToken(9), secret = randomToken(32), now = Date.now();
  if (old) await db().exec('UPDATE agents SET secret_enc=$1, rotated=$2, online=false, last_seen=NULL WHERE server_id=$3', [seal(secret), now, serverId]);
  else await db().exec('INSERT INTO agents(server_id,key_id,secret_enc,created) VALUES($1,$2,$3,$4)', [serverId, keyId, seal(secret), now]);
  await audit('pengguna', old ? 'agen.rotasi' : 'agen.buat', `server ${serverId}`);
  return { keyId, secret, rotated: !!old };
}
export async function remove(serverId: number): Promise<void> { await db().exec('DELETE FROM agents WHERE server_id=$1', [serverId]); await audit('pengguna', 'agen.hapus', `server ${serverId}`); }
/** Semua server dengan status agennya: hidup, mati (sempat terhubung, kini diam), belum pernah terhubung, atau belum dipasang. Yang bermasalah di atas. */
export interface FleetRow { server_id: number; name: string; state: 'mati' | 'belum_terhubung' | 'belum_dipasang' | 'hidup'; last_seen: number | null; version: string; exec_enabled: boolean; open_keys: number }
export async function fleet(): Promise<FleetRow[]> {
  const rows = await db().query<{ server_id: number; name: string; has: boolean; online: boolean | null; last_seen: number | null; version: string | null; exec_enabled: boolean | null; open_keys: number | null }>(
    'SELECT s.id AS server_id, s.name, (a.server_id IS NOT NULL) AS has, a.online, a.last_seen, a.version, a.exec_enabled, jsonb_array_length(a.open_keys)::int AS open_keys FROM servers s LEFT JOIN agents a ON a.server_id=s.id ORDER BY s.name');
  const out: FleetRow[] = rows.map((r) => ({ server_id: r.server_id, name: r.name, state: !r.has ? 'belum_dipasang' : r.last_seen == null ? 'belum_terhubung' : r.online ? 'hidup' : 'mati', last_seen: r.last_seen, version: r.version ?? '', exec_enabled: !!r.exec_enabled, open_keys: r.open_keys ?? 0 }));
  const rank = { mati: 0, belum_terhubung: 1, hidup: 2, belum_dipasang: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name, 'id', { numeric: true }));
}
export async function statusOf(serverId: number) {
  const a = await db().one<AgentRow>('SELECT * FROM agents WHERE server_id=$1', [serverId]); if (!a) return null;
  const { secret_enc, ...pub } = a; void secret_enc; return pub;
}
export async function byKey(keyId: string): Promise<(AgentRow & { secret: string }) | null> {
  const a = await db().one<AgentRow>('SELECT * FROM agents WHERE key_id=$1', [String(keyId).slice(0, 64)]); return a ? { ...a, secret: open(a.secret_enc) } : null;
}

// ---------- tanda tangan (harus identik dengan agent/transport.go)
const bodyHash = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export const signRequest = (secret: string, ts: string, method: string, path: string, body: Buffer | string): string => createHmac('sha256', secret).update(`${ts}\n${method}\n${path}\n${bodyHash(body)}`).digest('hex');
export function verifyRequest(secret: string, ts: string, method: string, path: string, body: Buffer, sig: string, now = Date.now()): boolean {
  const t = Number(ts); if (!Number.isFinite(t) || Math.abs(now - t * 1000) > MAX_SKEW_MS) return false;
  const want = Buffer.from(signRequest(secret, ts, method, path, body)), got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}
/** Anti-replay: tanda tangan yang sama tidak diterima dua kali di dalam jendela waktu. Mengembalikan false bila permintaan ini sudah pernah dilihat. */
let lastNonceSweep = 0;
export async function claimRequest(serverId: number, sig: string, now = Date.now()): Promise<boolean> {
  if (now - lastNonceSweep > 60_000) { lastNonceSweep = now; await db().exec('DELETE FROM agent_nonces WHERE seen<$1', [now - 2 * MAX_SKEW_MS]); }
  return (await db().exec('INSERT INTO agent_nonces(server_id,sig,seen) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [serverId, String(sig).slice(0, 128), now])) > 0;
}
export const signCommand = (secret: string, id: string, expires: number, timeoutS: number, command: string): string => createHmac('sha256', secret).update(`cmd\n${id}\n${expires}\n${timeoutS}\n${command}`).digest('hex');

// ---------- detak jantung
export interface Heartbeat { v?: string; host?: string; up?: number; exec?: boolean; open?: string[] | null; hb?: number }
export async function heartbeat(serverId: number, hb: Heartbeat, ip: string): Promise<{ ok: true; poll: boolean; patch: boolean }> {
  const open = Array.isArray(hb.open) ? hb.open.slice(0, 50).map((k) => String(k).slice(0, 120)) : [];
  await db().exec('UPDATE agents SET last_seen=$1, version=$2, hostname=$3, exec_enabled=$4, open_keys=$5::jsonb, online=true, last_ip=$6 WHERE server_id=$7', [Date.now(), String(hb.v ?? '').slice(0, 40), String(hb.host ?? '').slice(0, 120), !!hb.exec, JSON.stringify(open), ip.slice(0, 64), serverId]);
  if (hb.hb) await db().exec("INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [`agent_hb_${serverId}`, String(Math.min(3600, Math.max(15, Number(hb.hb))))]);
  await syncAlerts(serverId, [{ key: 'agent:offline', on: false }], 'agent');   // pulih bila sebelumnya mati
  const refresh = await db().one("DELETE FROM meta WHERE key=$1 RETURNING value", [`patch_refresh_${serverId}`]);   // setelah patch diterapkan: minta agen melapor ulang sekarang, tidak menunggu 6 jam
  return { ok: true, poll: await hasPending(serverId), patch: !!refresh };
}

// ---------- antrean perintah untuk agen
export async function hasPending(serverId: number): Promise<boolean> {
  return !!(await db().one("SELECT 1 AS x FROM agent_commands WHERE server_id=$1 AND status IN ('queued') AND expires>$2 LIMIT 1", [serverId, Date.now()]));
}
export async function enqueue(serverId: number, recId: number | null, stepN: number | null, command: string, timeoutS: number): Promise<string> {
  const id = 'c' + Date.now().toString(36) + randomToken(6).replace(/[^A-Za-z0-9]/g, 'x'), now = Date.now();
  await db().exec('INSERT INTO agent_commands(id,server_id,rec_id,step_n,command,timeout_s,expires,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, serverId, recId, stepN, command, timeoutS, now + 10 * 60_000, now]);
  return id;
}
export interface WireCommand { id: string; command: string; timeout_s: number; expires: number; sig: string }
// long-poll: tunggu sampai ada perintah antre atau waktu habis; perintah ditandai 'sent' agar tidak diberikan dua kali
export async function takeCommands(serverId: number, secret: string, waitSec: number, signal?: AbortSignal): Promise<{ commands: WireCommand[]; poll: boolean }> {
  const deadline = Date.now() + Math.min(25, Math.max(0, waitSec)) * 1000;
  for (;;) {
    const rows = await db().query("UPDATE agent_commands SET status='sent', sent_at=$1 WHERE id IN (SELECT id FROM agent_commands WHERE server_id=$2 AND status='queued' AND expires>$1 ORDER BY created LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING *", [Date.now(), serverId]);
    if (rows.length) return { commands: rows.map((r) => { const exp = Math.floor(r.expires / 1000); return { id: r.id, command: r.command, timeout_s: r.timeout_s, expires: exp, sig: signCommand(secret, r.id, exp, r.timeout_s, r.command) }; }), poll: true };
    if (Date.now() >= deadline || signal?.aborted) return { commands: [], poll: await hasPending(serverId) };
    await new Promise((r) => setTimeout(r, 400));
  }
}
export async function recordResult(serverId: number, id: string, r: { exit?: number; stdout?: string; stderr?: string; rejected?: string }): Promise<boolean> {
  const rej = String(r.rejected ?? '').slice(0, 300);
  const n = await db().exec("UPDATE agent_commands SET status=$1, finished=$2, exit_code=$3, stdout=$4, stderr=$5, rejected=$6 WHERE id=$7 AND server_id=$8 AND status IN ('sent','queued')", [rej ? 'rejected' : 'done', Date.now(), Number.isFinite(r.exit) ? r.exit : 1, redactOutput(r.stdout).slice(0, 20000), redactOutput(r.stderr).slice(0, 20000), rej, id, serverId]);
  return n > 0;
}
export async function waitResult(id: string, timeoutMs: number): Promise<Record<string, any>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const c = await db().one('SELECT * FROM agent_commands WHERE id=$1', [id]);
    if (c && ['done', 'rejected', 'cancelled'].includes(c.status)) return c;
    if (Date.now() > end || (c && c.expires < Date.now() && c.status === 'queued')) { await db().exec("UPDATE agent_commands SET status='expired' WHERE id=$1 AND status IN ('queued','sent')", [id]); return { ...(c ?? {}), status: 'expired', exit_code: 124, stderr: 'agen tidak mengambil/menyelesaikan perintah tepat waktu', stdout: '' }; }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---------- pengawas: agen yang berhenti mengirim detak jantung
export async function watchdog(now = Date.now()): Promise<void> {
  for (const a of await db().query("SELECT a.server_id, a.last_seen, s.name, COALESCE((SELECT value FROM meta WHERE key='agent_hb_'||a.server_id), '60') AS hb FROM agents a JOIN servers s ON s.id=a.server_id WHERE a.online AND a.last_seen IS NOT NULL")) {
    const limit = Math.max(180, 3 * Number(a.hb)) * 1000;
    if (now - a.last_seen > limit) {
      await db().exec('UPDATE agents SET online=false WHERE server_id=$1', [a.server_id]);
      await syncAlerts(a.server_id, [{ key: 'agent:offline', on: true, level: 'critical', title: 'Agen tidak mengirim detak jantung', detail: `terakhir terlihat ${Math.round((now - a.last_seen) / 1000)} detik lalu (batas ${Math.round(limit / 1000)} detik). Server mati, jaringan putus, atau agen berhenti.` }], 'agent');
    }
  }
}

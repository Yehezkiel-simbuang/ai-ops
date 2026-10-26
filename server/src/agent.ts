// Agen setup server. Satu perintah per giliran: model mengusulkan, kebijakan (safety.ts) mengklasifikasi,
// perintah baca dijalankan otomatis, perintah yang mengubah sesuatu MENUNGGU persetujuan di UI, perintah merusak diblokir.
// Semua perintah, keluaran, keputusan, dan token tercatat di database. Persetujuan diklaim atomik (tidak bisa dijalankan dua kali).
import { audit, bad, db, log } from './context.js';
import { forRole, type RoleChat } from './llm.js';
import * as Notify from './notify.js';
import { classify } from './safety.js';
import { redactOutput } from './redact.js';
import * as Servers from './servers.js';
import * as Store from './store.js';

const dep: { llm: RoleChat } = { llm: forRole };
export function configure(o: { llm?: RoleChat }): void { if (o.llm) dep.llm = o.llm; }
const active = new Map<string, { stop: boolean }>();

async function setStatus(runId: string, status: string, summary?: string | null): Promise<void> {
  await db().exec('UPDATE runs SET status=$1, summary=COALESCE($2,summary), updated=$3 WHERE id=$4', [status, summary == null ? null : String(summary).slice(0, 2000), Date.now(), runId]);
  if (status === 'done' || status === 'failed') { const r = await Store.getRun(runId); if (r) void Notify.runFinished(r as never); }
}
const addMsg = (runId: string, role: 'user' | 'assistant', content: string) => db().exec('INSERT INTO messages(run_id,ts,role,content) VALUES($1,$2,$3,$4)', [runId, Date.now(), role, content]);
const clip = (s: unknown, n: number): string => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n / 2)}\n... [dipotong] ...\n${t.slice(-n / 2)}` : t; };

export function systemPrompt(run: Record<string, any>, server: Servers.ServerRow): string {
  const steps = (run.steps ?? []).map((s: any) => `${s.id}. [${s.status}] ${s.title}${s.detail ? ` (${clip(s.detail, 240)})` : ''}`).join('\n') || '(tidak ada rencana tertulis; susun sendiri)';
  return [
    'Kamu adalah agen setup dan tuning server untuk satu pengguna yang bertanggung jawab atas server ini. Bahasa: Indonesia, ringkas.',
    `Server: ${server.name} (${server.username}@${server.host})${server.os_info ? ', ' + server.os_info : ''}${server.use_sudo ? '. Pengguna memiliki sudo tanpa password; awali perintah yang butuh root dengan "sudo -n".' : '. Tidak ada sudo.'}${server.notes ? ' Catatan pengguna: ' + clip(server.notes, 400) : ''}`,
    `Tujuan: ${run.goal || '(lihat rencana)'}`,
    `Rencana langkah:\n${steps}`,
    '',
    'ATURAN KERJA',
    '1. Satu perintah shell per giliran. Perintah non-interaktif saja (tanpa editor, tanpa prompt, tanpa top tanpa -b).',
    '2. Kumpulkan bukti dulu dengan perintah baca; jangan menebak. Jelaskan alasan setiap perintah di "purpose".',
    '3. Perintah baca dijalankan otomatis. Perintah yang mengubah sesuatu diteruskan ke pengguna untuk disetujui; usulkan perubahan sekecil dan semudah dibalik mungkin: cadangkan berkas sebelum diedit (cp -a), validasi konfigurasi sebelum reload (nginx -t, php-fpm -tt), ubah satu hal per giliran, lalu verifikasi hasilnya.',
    '4. Perintah merusak (hapus rekursif, format, reboot, DROP DATABASE, dsb.) diblokir. Jangan mengusulkannya; minta pengguna melakukannya manual bila memang perlu.',
    '5. Jangan menampilkan rahasia (password, token, kunci). Keluaran yang panjang dipotong; persempit dengan grep/head/tail.',
    '6. Bila hasil perintah menunjukkan asumsimu salah, katakan dan ubah rencana.',
    '7. Bila selesai atau tidak bisa lanjut, set "done": true dengan ringkasan: apa yang diubah, bukti sebelum/sesudah, dan yang masih perlu dilakukan pengguna.',
    '',
    'FORMAT BALASAN: hanya satu objek JSON, tanpa teks lain:',
    '{"thought":"alasan singkat","command":"perintah shell atau kosong bila done","purpose":"tujuan perintah","steps":[{"n":1,"status":"running|done|failed|skipped","note":"opsional"}],"done":false,"summary":""}'
  ].join('\n');
}

export interface Reply { thought?: string; command?: string; purpose?: string; steps?: Array<{ n: number; status: string; note?: string }>; done?: boolean; summary?: string }
export function parseReply(text: string): Reply | null {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(t.slice(a, b + 1)); return j && typeof j === 'object' ? (j as Reply) : null; } catch { return null; }
}

const history = async (runId: string) => (await db().query('SELECT role, content FROM messages WHERE run_id=$1 ORDER BY id', [runId])).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
const outputMsg = (c: Record<string, any>): string => `HASIL perintah #${c.id} (exit ${c.exit_code}):\n${c.stdout ? `STDOUT:\n${clip(c.stdout, 6000)}\n` : ''}${c.stderr ? `STDERR:\n${clip(c.stderr, 2000)}\n` : ''}${!c.stdout && !c.stderr ? '(tanpa keluaran)\n' : ''}`;

async function execute(cmdId: number, decidedBy: string): Promise<Record<string, any>> {
  const c = (await db().one('SELECT * FROM commands WHERE id=$1', [cmdId]))!, server = c.server_id ? await Servers.get(c.server_id) : undefined;
  await db().exec('UPDATE commands SET status=$1, started=$2, decided_by=COALESCE($3,decided_by) WHERE id=$4', ['running', Date.now(), decidedBy, cmdId]);
  const r = server ? await Servers.run(server, c.command, { timeoutMs: c.class === 'read' ? 30_000 : 120_000 }) : { exitCode: 255, stdout: '', stderr: 'Server sudah dihapus' };
  await db().exec('UPDATE commands SET status=$1, exit_code=$2, stdout=$3, stderr=$4, finished=$5 WHERE id=$6', [r.exitCode === 0 ? 'done' : 'failed', r.exitCode, redactOutput(r.stdout), redactOutput(r.stderr), Date.now(), cmdId]);
  await audit(decidedBy, 'perintah.jalan', `#${cmdId} [${c.class}] ${String(c.command).slice(0, 200)} -> exit ${r.exitCode}`);
  return (await db().one('SELECT * FROM commands WHERE id=$1', [cmdId]))!;
}
async function applySteps(runId: string, steps: Reply['steps']): Promise<void> {
  for (const s of Array.isArray(steps) ? steps : []) { try { if (s && s.n != null && s.status) await Store.setStep(runId, s.n, String(s.status), s.note); } catch { /* langkah tidak dikenal: abaikan */ } }
}

async function loop(runId: string): Promise<void> {
  const ctl = active.get(runId)!; let invalid = 0;
  try {
    for (;;) {
      if (ctl.stop) { await setStatus(runId, 'stopped', 'Dihentikan pengguna'); return; }
      const run = (await Store.getRun(runId))!, server = run.server_id ? await Servers.get(run.server_id) : undefined;
      if (!server) { await setStatus(runId, 'failed', 'Server tidak ditemukan'); return; }
      if (await db().one("SELECT 1 AS x FROM commands WHERE run_id=$1 AND status='pending_approval'", [runId])) { await setStatus(runId, 'waiting_approval'); return; }
      if (run.turns >= run.max_turns) { await setStatus(runId, 'stopped', `Batas ${run.max_turns} giliran tercapai. Lanjutkan dengan membuat run baru bila perlu.`); return; }
      if (run.tokens >= run.token_budget) { await setStatus(runId, 'stopped', `Anggaran token run habis (${run.tokens} dari ${run.token_budget}).`); return; }

      let msgs = await history(runId);
      if (!msgs.length) { await addMsg(runId, 'user', `Mulai. Tujuan: ${run.goal || 'ikuti rencana langkah'}. Usulkan perintah pertama (baca dulu).`); msgs = await history(runId); }
      let reply;
      try { reply = await dep.llm('setup', { system: systemPrompt(run, server), messages: msgs, maxTokens: 1500, run: runId }); }
      catch (e) { await setStatus(runId, 'failed', `Panggilan model gagal: ${(e as Error).message}`); return; }
      if (ctl.stop) { await setStatus(runId, 'stopped', 'Dihentikan pengguna'); return; }
      await addMsg(runId, 'assistant', reply.text || '(kosong)');
      await db().exec('UPDATE runs SET turns=turns+1, updated=$1 WHERE id=$2', [Date.now(), runId]);

      const a = parseReply(reply.text);
      if (!a) { if (++invalid >= 3) { await setStatus(runId, 'failed', 'Model tiga kali membalas dengan format tidak valid.'); return; } await addMsg(runId, 'user', 'Balasanmu bukan JSON yang valid. Balas hanya dengan satu objek JSON sesuai format.'); continue; }
      await applySteps(runId, a.steps);
      if (a.done) { await setStatus(runId, 'done', a.summary || a.thought || 'Selesai'); return; }
      const command = String(a.command || '').trim();
      if (!command) { if (++invalid >= 3) { await setStatus(runId, 'failed', 'Model tidak memberi perintah dan tidak menyatakan selesai.'); return; } await addMsg(runId, 'user', 'Tidak ada perintah dan "done" belum true. Beri satu perintah, atau set done dengan ringkasan.'); continue; }
      invalid = 0;

      const cl = classify(command), status = cl.cls === 'blocked' ? 'blocked' : cl.cls === 'read' ? 'approved' : 'pending_approval';
      const ins = await db().one<{ id: number }>('INSERT INTO commands(run_id,server_id,ts,command,purpose,class,status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [runId, server.id, Date.now(), command, String(a.purpose || a.thought || '').slice(0, 500), cl.cls, status, cl.why]);
      const id = ins!.id;
      if (cl.cls === 'blocked') { await addMsg(runId, 'user', `PERINTAH #${id} DIBLOKIR: ${cl.why}. Usulkan alternatif yang aman atau minta pengguna melakukannya manual.`); continue; }
      if (cl.cls === 'change') { await setStatus(runId, 'waiting_approval'); Notify.approvalPending({ command }, run.name, server.name); return; }
      await setStatus(runId, 'running');
      await addMsg(runId, 'user', outputMsg(await execute(id, 'agen (baca)')));
    }
  } catch (e) { log().error({ err: (e as Error).message, run: runId }, 'loop agen gagal'); await setStatus(runId, 'failed', `Kesalahan internal: ${(e as Error).message}`); }
  finally { const st = (await Store.getRun(runId))?.status; if (st !== 'running' && st !== 'waiting_approval' && active.get(runId) === ctl) active.delete(runId); }
}

export async function start(runId: string) {
  const run = await Store.getRun(runId); if (!run) throw bad('Run tidak ada');
  if (!run.server_id) throw bad('Pilih server untuk run ini');
  if (!(await Store.getRole('setup'))) throw bad('Atur model peran Setup server dulu (Pengaturan)');
  if (active.has(runId)) throw bad('Run sudah berjalan');
  active.set(runId, { stop: false }); await setStatus(runId, 'running'); await audit('pengguna', 'run.mulai', runId);
  void loop(runId); return Store.getRun(runId);
}
async function resume(runId: string): Promise<void> { const c = active.get(runId) ?? { stop: false }; c.stop = false; active.set(runId, c); await setStatus(runId, 'running'); void loop(runId); }
export async function stop(runId: string): Promise<void> {
  const c = active.get(runId), st = (await Store.getRun(runId))?.status;
  if (c && st === 'running') c.stop = true; else { active.delete(runId); await setStatus(runId, 'stopped', 'Dihentikan pengguna'); }
  await db().exec("UPDATE commands SET status='rejected', reason='run dihentikan' WHERE run_id=$1 AND status='pending_approval'", [runId]); await audit('pengguna', 'run.henti', runId);
}

export async function decide(cmdId: number | string, approve: boolean, reason?: string): Promise<Record<string, any>> {
  // klaim atomik: hanya satu pemanggil yang berhasil mengubah pending_approval, jadi perintah tidak mungkin berjalan dua kali
  const claimed = await db().one("UPDATE commands SET status=$1, decided_by='pengguna', reason=CASE WHEN $2 THEN reason ELSE $3 END WHERE id=$4 AND status='pending_approval' RETURNING *", [approve ? 'approved' : 'rejected', approve, String(reason || 'ditolak').slice(0, 300), Number(cmdId)]);
  if (!claimed) { if (!(await db().one('SELECT 1 AS x FROM commands WHERE id=$1', [Number(cmdId)]))) throw bad('Perintah tidak ada'); throw bad('Perintah ini sudah diputuskan'); }
  if (!approve) {
    await audit('pengguna', 'perintah.tolak', `#${claimed.id}`);
    await addMsg(claimed.run_id, 'user', `PERINTAH #${claimed.id} DITOLAK pengguna${reason ? ': ' + reason : ''}. Jangan jalankan itu; usulkan alternatif atau jelaskan mengapa perlu.`);
  } else {
    await audit('pengguna', 'perintah.setuju', `#${claimed.id} ${String(claimed.command).slice(0, 200)}`);
    await addMsg(claimed.run_id, 'user', outputMsg(await execute(claimed.id, 'pengguna')));
  }
  if (!(await db().one("SELECT 1 AS x FROM commands WHERE run_id=$1 AND status='pending_approval'", [claimed.run_id]))) await resume(claimed.run_id);
  return (await db().one('SELECT * FROM commands WHERE id=$1', [claimed.id]))!;
}

// run yang tertinggal 'running' saat proses dimatikan: tandai terputus
export async function recover(): Promise<void> { await db().exec("UPDATE runs SET status='interrupted', updated=$1 WHERE status='running'", [Date.now()]); }

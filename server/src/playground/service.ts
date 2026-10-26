// Server playground: memasang susunan Docker Compose di server uji lewat SSH, memeriksa kesehatannya, dan mencopotnya.
// Hanya server yang ditandai playground yang boleh dipasangi. Pemasangan berjalan di latar belakang; UI memantau status.
import http from 'node:http';
import { z } from 'zod';
import { audit, bad, db, log } from '../context.js';
import { open, seal } from '../crypto.js';
import { redactOutput } from '../redact.js';
import * as Servers from '../servers.js';
import { analyze, MAX_COMPOSE_CHARS, targetPort, type ComposeAnalysis } from './compose.js';

type Status = 'draft' | 'deploying' | 'running' | 'failed' | 'stopping' | 'stopped';
const BUSY = new Set<number>();   // satu operasi pada satu waktu per susunan
const opt = { pollMs: 5000, readyTries: 24, healthTries: 12, httpGet: defaultHttpGet };
export function configure(o: Partial<typeof opt>): void { Object.assign(opt, o); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function defaultHttpGet(url: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000, agent: false }, (res) => { res.destroy(); resolve(res.statusCode ?? 0); });
    req.on('timeout', () => { req.destroy(); resolve(0); }); req.on('error', () => resolve(0));
  });
}

export const createSchema = z.object({
  server_id: z.number().int().positive(),
  name: z.string().trim().min(1).max(60).regex(/^[\w .-]+$/, 'Nama hanya boleh huruf, angka, spasi, titik, minus, dan garis bawah'),
  compose: z.string().max(MAX_COMPOSE_CHARS),
  health_path: z.string().trim().max(200).regex(/^(\/\S*)?$/, 'Path kesehatan harus diawali / dan tanpa spasi').default(''),
  target_port: z.number().int().min(0).max(65535).default(0)
});
export const patchSchema = z.object({
  name: createSchema.shape.name.optional(), compose: z.string().max(MAX_COMPOSE_CHARS).optional(),
  health_path: z.string().trim().max(200).regex(/^(\/\S*)?$/, 'Path kesehatan harus diawali / dan tanpa spasi').optional(), target_port: z.number().int().min(0).max(65535).optional()
});

const project = (id: number) => `aiops-pg-${id}`;
const dir = (id: number) => `"$HOME/aiops-playground/${id}"`;

function view(row: Record<string, any>) {
  const { compose_enc, ...rest } = row;
  return { ...rest, compose: open(compose_enc), analysis: analyze(open(compose_enc)) };
}

async function playgroundServer(serverId: number): Promise<Servers.ServerRow> {
  const s = await Servers.get(serverId); if (!s) throw bad('Server tidak ada');
  if (!s.playground) throw bad('Server ini belum ditandai playground. Centang "Server playground" di pengaturan server lebih dulu. Hanya server uji yang boleh dipasangi.');
  return s;
}

export async function list() {
  const rows = await db().query('SELECT d.*, s.name AS server_name, s.host AS server_host FROM playground_deploys d JOIN servers s ON s.id=d.server_id ORDER BY d.updated DESC');
  return rows.map(view);
}
async function getRow(id: number) { const r = await db().one('SELECT d.*, s.name AS server_name, s.host AS server_host FROM playground_deploys d JOIN servers s ON s.id=d.server_id WHERE d.id=$1', [id]); if (!r) throw bad('Susunan tidak ada'); return r; }
export async function get(id: number) { return view(await getRow(id)); }

function assertDeployable(a: ComposeAnalysis): void { if (a.problems.length) throw bad('Compose belum bisa dipasang:\n- ' + a.problems.join('\n- ')); }

export async function create(b: z.infer<typeof createSchema>, actor: string) {
  await playgroundServer(b.server_id); assertDeployable(analyze(b.compose));
  const now = Date.now();
  try { const r = await db().one<{ id: number }>('INSERT INTO playground_deploys(server_id,name,compose_enc,health_path,target_port,created,updated) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id', [b.server_id, b.name, seal(b.compose), b.health_path, b.target_port, now]); await audit(actor, 'playground.buat', b.name); return get(r!.id); }
  catch (e) { if ((e as { code?: string }).code === '23505') throw bad('Nama susunan sudah dipakai di server ini'); throw e; }
}

export async function update(id: number, b: z.infer<typeof patchSchema>, actor: string) {
  const cur = await getRow(id);
  if (!['draft', 'stopped', 'failed'].includes(cur.status)) throw bad('Hentikan (copot) susunan ini dulu sebelum mengubahnya');
  const compose = b.compose ?? open(cur.compose_enc); assertDeployable(analyze(compose));
  try { await db().exec('UPDATE playground_deploys SET name=$2,compose_enc=$3,health_path=$4,target_port=$5,updated=$6 WHERE id=$1', [id, b.name ?? cur.name, seal(compose), b.health_path ?? cur.health_path, b.target_port ?? cur.target_port, Date.now()]); }
  catch (e) { if ((e as { code?: string }).code === '23505') throw bad('Nama susunan sudah dipakai di server ini'); throw e; }
  await audit(actor, 'playground.ubah', cur.name); return get(id);
}

export async function remove(id: number, actor: string): Promise<void> {
  const cur = await getRow(id);
  if (!['draft', 'stopped'].includes(cur.status)) throw bad('Copot susunan dulu (tekan Copot) sebelum menghapusnya, agar kontainer dan datanya tidak tertinggal di server');
  await db().exec('DELETE FROM playground_deploys WHERE id=$1', [id]); await audit(actor, 'playground.hapus', cur.name);
}

async function save(id: number, patch: { status?: Status; detail?: string; log?: string; target?: string; deployed?: number }): Promise<void> {
  const sets: string[] = ['updated=$2'], vals: unknown[] = [id, Date.now()];
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) { vals.push(v); sets.push(`${k}=$${vals.length}`); }
  await db().exec(`UPDATE playground_deploys SET ${sets.join(',')} WHERE id=$1`, vals);
}
const clipLog = (raw: string) => { const s = redactOutput(raw); return s.length > 8000 ? '...' + s.slice(-8000) : s; };

interface Container { Service: string; State: string; Health?: string }
export function parsePs(out: string): Container[] {
  const t = out.trim(); if (!t) return [];
  try { const j = JSON.parse(t); return (Array.isArray(j) ? j : [j]) as Container[]; } catch { /* NDJSON */ }
  return t.split('\n').flatMap((l) => { try { return [JSON.parse(l) as Container]; } catch { return []; } });
}
const unready = (cs: Container[]) => cs.filter((c) => c.State !== 'running' || (c.Health && c.Health !== 'healthy'));

async function ssh(s: Servers.ServerRow, cmd: string, ms = 60_000) { return Servers.run(s, cmd, { timeoutMs: ms }); }

async function runDeploy(id: number): Promise<void> {
  const row = await getRow(id), s = await playgroundServer(row.server_id), compose = open(row.compose_enc), a = analyze(compose);
  let logText = '';
  const note = (t: string) => { logText += `${t}\n`; };
  const fail = async (detail: string) => {
    const lg = await ssh(s, `cd ${dir(id)} 2>/dev/null && docker compose -p ${project(id)} logs --no-color --tail 40 2>&1`, 30_000).catch(() => null);
    if (lg?.stdout) note(`--- log kontainer ---\n${lg.stdout}`);
    await save(id, { status: 'failed', detail, log: clipLog(logText) });
  };
  try {
    const pre = await ssh(s, "docker compose version --short 2>&1 && docker info --format '{{.ServerVersion}}' 2>&1", 30_000); note(`$ docker compose version\n${pre.stdout}${pre.stderr}`);
    if (pre.exitCode !== 0) return await fail('Docker atau Docker Compose belum terpasang di server ini, atau pengguna SSH tidak boleh memakainya (tambahkan pengguna ke grup docker).');
    const b64 = Buffer.from(compose, 'utf8').toString('base64');
    const w = await ssh(s, `mkdir -p ${dir(id)} && printf %s '${b64}' | base64 -d > ${dir(id)}/docker-compose.yml`, 30_000); note(`$ tulis docker-compose.yml (exit ${w.exitCode})`);
    if (w.exitCode !== 0) return await fail(`Gagal menulis berkas di server: ${w.stderr.trim().slice(0, 200)}`);
    const up = await ssh(s, `cd ${dir(id)} && docker compose -p ${project(id)} up -d --remove-orphans 2>&1`, 600_000); note(`$ docker compose up -d\n${up.stdout}${up.stderr}`);
    if (up.exitCode !== 0) return await fail('docker compose up gagal (lihat log). Penyebab umum: image tidak ditemukan atau butuh login registry, port sudah dipakai, atau memori habis.');
    let cs: Container[] = [];
    for (let i = 0; i < opt.readyTries; i++) {
      const ps = await ssh(s, `cd ${dir(id)} && docker compose -p ${project(id)} ps --format json 2>&1`, 30_000); cs = parsePs(ps.stdout);
      if (cs.length && !unready(cs).length) break;
      if (cs.some((c) => ['exited', 'dead'].includes(c.State))) break;
      await sleep(opt.pollMs);
    }
    note(`$ docker compose ps\n${cs.map((c) => `${c.Service}: ${c.State}${c.Health ? ` (${c.Health})` : ''}`).join('\n')}`);
    if (!cs.length || unready(cs).length) return await fail(`Layanan belum siap: ${unready(cs).map((c) => `${c.Service} (${c.State}${c.Health ? `, ${c.Health}` : ''})`).join(', ') || 'tidak ada kontainer'}`);
    const port = targetPort(a, row.target_port), target = port ? `http://${s.host}:${port}` : '';
    if (target && row.health_path) {
      let code = 0;
      for (let i = 0; i < opt.healthTries; i++) { code = await opt.httpGet(target + row.health_path); if (code >= 200 && code < 400) break; await sleep(opt.pollMs); }
      note(`$ GET ${target}${row.health_path} -> ${code}`);
      if (!(code >= 200 && code < 400)) return await fail(`Kontainer berjalan, tetapi ${row.health_path} tidak menjawab sehat (status ${code || 'tidak terjangkau'}). Periksa port yang dipublikasikan dan firewall server.`);
    }
    await save(id, { status: 'running', target, detail: `${cs.length} layanan berjalan${target ? `; target uji ${target}` : '; tidak ada port yang dipublikasikan'}`, log: clipLog(logText), deployed: Date.now() });
  } catch (e) { await save(id, { status: 'failed', detail: `Galat: ${(e as Error).message.slice(0, 300)}`, log: clipLog(logText) }); }
}

export async function deploy(id: number, actor: string) {
  const row = await getRow(id), s = await playgroundServer(row.server_id); assertDeployable(analyze(open(row.compose_enc)));
  if (BUSY.has(id) || ['deploying', 'stopping'].includes(row.status)) throw bad('Susunan ini sedang diproses');
  BUSY.add(id); await save(id, { status: 'deploying', detail: 'Memasang... (menarik image bisa memakan beberapa menit)', log: '' }); await audit(actor, 'playground.pasang', `${row.name} di ${s.name}`);
  const started = await get(id);   // keadaan awal dikembalikan; kelanjutannya dipantau UI lewat polling
  void runDeploy(id).catch((e) => log().error({ err: (e as Error).message }, 'pemasangan playground gagal')).finally(() => BUSY.delete(id));
  return started;
}

async function runStop(id: number): Promise<void> {
  const row = await getRow(id), s = await playgroundServer(row.server_id);
  const r = await ssh(s, `cd ${dir(id)} 2>/dev/null && docker compose -p ${project(id)} down -v --remove-orphans 2>&1; rm -rf ${dir(id)}; docker ps -a --filter label=com.docker.compose.project=${project(id)} -q | wc -l`, 300_000);
  const left = Number(r.stdout.trim().split('\n').pop()) || 0;
  if (r.exitCode !== 0 || left > 0) await save(id, { status: 'failed', detail: `Pencopotan belum tuntas (${left} kontainer tersisa). Coba lagi.`, log: clipLog(r.stdout + r.stderr) });
  else await save(id, { status: 'stopped', target: '', detail: 'Dicopot: kontainer, jaringan, dan volume dihapus dari server.', log: clipLog(r.stdout) });
}

export async function stop(id: number, actor: string) {
  const row = await getRow(id); await playgroundServer(row.server_id);
  if (BUSY.has(id) || ['deploying', 'stopping'].includes(row.status)) throw bad('Susunan ini sedang diproses');
  if (row.status === 'draft') throw bad('Susunan ini belum pernah dipasang');
  BUSY.add(id); await save(id, { status: 'stopping', detail: 'Mencopot...' }); await audit(actor, 'playground.copot', row.name);
  const started = await get(id);
  void runStop(id).catch(async (e) => { await save(id, { status: 'failed', detail: `Galat saat mencopot: ${(e as Error).message.slice(0, 200)}` }); }).finally(() => BUSY.delete(id));
  return started;
}

/** Keadaan kontainer saat ini di server (tidak mengubah status susunan). */
export async function containers(id: number) {
  const row = await getRow(id), s = await playgroundServer(row.server_id);
  const r = await ssh(s, `cd ${dir(id)} 2>/dev/null && docker compose -p ${project(id)} ps --format json 2>&1`, 30_000);
  return r.exitCode === 0 ? parsePs(r.stdout) : [];
}
export async function logs(id: number): Promise<string> {
  const row = await getRow(id), s = await playgroundServer(row.server_id);
  const r = await ssh(s, `cd ${dir(id)} 2>/dev/null && docker compose -p ${project(id)} logs --no-color --tail 200 2>&1`, 30_000);
  return r.stdout || r.stderr || 'Belum ada log.';
}

/** Dipanggil saat aplikasi mulai: operasi yang terputus tidak boleh tergantung selamanya. */
export async function recover(): Promise<void> {
  await db().exec("UPDATE playground_deploys SET status='failed', detail='Terputus karena aplikasi dimulai ulang. Periksa lalu pasang ulang atau copot.', updated=$1 WHERE status IN ('deploying','stopping')", [Date.now()]);
}

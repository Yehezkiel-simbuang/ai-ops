// Uji beban: penyimpanan dan siklus status (draft -> queued -> running -> done/failed/cancelled).
// Persetujuan: uji hanya masuk antrean lewat queue() yang dipanggil dari aksi eksplisit pengguna; runner tidak pernah memulai uji sendiri.
import { HttpError, audit, bad, db } from '../context.js';
import { open, seal } from '../crypto.js';
import { analyze, type Analysis, type StageRow } from './analysis.js';
import { analyzeWithLimits as analyze_ } from '../playground/compose.js';
import { checkTarget } from './safety.js';
import { MAX_GEN_CPU, type CreateInput, type Criteria, type LoadRequest, type LoadStage, type StageReport } from './schema.js';

export type TestStatus = 'draft' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
interface Scenario { requests: LoadRequest[]; thinkSeconds: number; headerNames: string[] }
export interface TestRow {
  id: number; name: string; target: string; allow_public: boolean; scenario: Scenario; headers_enc: string; stages: LoadStage[]; criteria: Criteria; scrape: Array<{ label: string; url: string; metric: string }>;
  status: TestStatus; cancel_requested: boolean; error: string; runner: { k6: string; cpus: number; version: string } | null; approved_by: string;
  created: number; started: number | null; finished: number | null; heartbeat: number | null; setup: SetupSummary | null;
}
export interface SetupSummary { name: string; services: Array<{ name: string; image: string }>; limits: string[] }
export interface StageDb extends StageRow { reqs: number; p50: number; p99: number; scraped: Record<string, { avg: number; max: number; last: number }>; started: number; ended: number }

/** Bentuk untuk UI: tanpa header terenkripsi. */
const view = (t: TestRow) => { const { headers_enc: _h, ...rest } = t; return rest; };

const stageRows = (test_id: number) => db().query<StageDb & { err_pct: number; gen_cpu: number }>('SELECT idx, vus, seconds, reqs, rps, p50, p95, p99, err_pct, gen_cpu, valid, scraped, started, ended FROM load_stages WHERE test_id=$1 ORDER BY idx', [test_id])
  .then((rs) => rs.map((r) => ({ ...r, errPct: r.err_pct, genCpu: r.gen_cpu })));

export async function create(input: CreateInput, user: string, allowedHosts: string[]) {
  const t = checkTarget(input.target, allowedHosts);
  for (const s of input.scrape) checkTarget(s.url, allowedHosts, true);   // alamat metrik juga hanya ke jaringan yang boleh
  const scenario: Scenario = { requests: input.requests, thinkSeconds: input.thinkSeconds, headerNames: Object.keys(input.headers) };
  let setup: SetupSummary | null = null;
  if (input.playgroundId) {
    const p = await db().one<{ name: string; compose_enc: string }>('SELECT name, compose_enc FROM playground_deploys WHERE id=$1', [input.playgroundId]);
    if (p) { const a = analyze_(open(p.compose_enc)); setup = { name: p.name, services: a.services.map((s) => ({ name: s.name, image: s.image })), limits: a.limits }; }
  }
  const row = await db().one<TestRow>(
    'INSERT INTO load_tests(name,target,allow_public,scenario,headers_enc,stages,criteria,scrape,created,setup) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [input.name, t.origin, t.allowPublic, JSON.stringify(scenario), Object.keys(input.headers).length ? seal(JSON.stringify(input.headers)) : '', JSON.stringify(input.stages), JSON.stringify(input.criteria), JSON.stringify(input.scrape), Date.now(), setup ? JSON.stringify(setup) : null]
  );
  await audit(user, 'loadtest.buat', `${input.name} -> ${t.origin}`);
  return view(row!);
}

export async function list() {
  const tests = await db().query<TestRow>('SELECT * FROM load_tests ORDER BY id DESC LIMIT 100');
  const stages = await db().query<StageRow & { test_id: number; err_pct: number; gen_cpu: number }>('SELECT test_id, idx, vus, seconds, rps, p95, err_pct, gen_cpu, valid FROM load_stages WHERE test_id = ANY($1::int[]) ORDER BY idx', [tests.map((t) => t.id)]);
  return tests.map((t) => {
    const mine = stages.filter((s) => s.test_id === t.id).map((s) => ({ ...s, errPct: s.err_pct, genCpu: s.gen_cpu }));
    return { ...view(t), stageCount: mine.length, analysis: analyze(mine, t.criteria, t.status === 'done') };
  });
}

export async function get(id: number) {
  const t = await db().one<TestRow>('SELECT * FROM load_tests WHERE id=$1', [id]);
  if (!t) throw new HttpError(404, 'Uji beban tidak ada');
  const stages = await stageRows(id);
  return { ...view(t), plan: t.stages, stages, analysis: analyze(stages, t.criteria, t.status === 'done') };   // plan = rencana tahap; stages = hasil yang sudah dilaporkan
}

/** Beberapa uji berdampingan: ringkasan hasil dan susunan yang diuji, untuk membandingkan "sebelum dan sesudah". */
export async function compare(ids: number[]) {
  const out = [];
  for (const id of ids) { const t = await get(id); out.push({ id: t.id, name: t.name, status: t.status, setup: t.setup, criteria: t.criteria, healthy: t.analysis.healthy, knee: t.analysis.knee, verdict: t.analysis.verdict, stages: t.stages.map((s) => ({ vus: s.vus, rps: s.rps, p95: s.p95, errPct: s.errPct, valid: s.valid })) }); }
  return out;
}

export async function remove(id: number): Promise<void> {
  const t = await db().one<{ status: TestStatus }>('SELECT status FROM load_tests WHERE id=$1', [id]);
  if (!t) return;
  if (t.status === 'running' || t.status === 'queued') throw bad('Uji sedang berjalan atau antre. Batalkan dulu.');
  await db().exec('DELETE FROM load_tests WHERE id=$1', [id]);
}

/** Salin definisi uji menjadi draf baru (untuk mengulang dengan target/beban yang sama). */
export async function duplicate(id: number, user: string) {
  const t = await db().one<TestRow>('SELECT * FROM load_tests WHERE id=$1', [id]);
  if (!t) throw new HttpError(404, 'Uji beban tidak ada');
  const row = await db().one<TestRow>(
    'INSERT INTO load_tests(name,target,allow_public,scenario,headers_enc,stages,criteria,scrape,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [`${t.name} (ulang)`.slice(0, 80), t.target, t.allow_public, JSON.stringify(t.scenario), t.headers_enc, JSON.stringify(t.stages), JSON.stringify(t.criteria), JSON.stringify(t.scrape), Date.now()]
  );
  await audit(user, 'loadtest.salin', t.name);
  return view(row!);
}

/** Persetujuan: aksi eksplisit pengguna. Hanya draf yang bisa masuk antrean, dan hanya satu uji yang boleh berjalan/antre pada satu waktu. */
export async function queue(id: number, user: string) {
  return db().tx(async (tx) => {
    const t = await tx.one<TestRow>('SELECT * FROM load_tests WHERE id=$1 FOR UPDATE', [id]);
    if (!t) throw new HttpError(404, 'Uji beban tidak ada');
    if (t.status !== 'draft') throw bad('Hanya uji berstatus draf yang bisa dijalankan. Gunakan "Jalankan lagi" untuk mengulang.');
    const busy = await tx.one('SELECT id FROM load_tests WHERE status IN (\'queued\',\'running\') LIMIT 1');
    if (busy) throw bad('Masih ada uji lain yang antre atau berjalan. Satu pembangkit beban hanya menjalankan satu uji.');
    await tx.exec("UPDATE load_tests SET status='queued', approved_by=$1, error='' WHERE id=$2", [user, id]);
    const total = t.stages.reduce((s, x) => s + x.seconds, 0), peak = Math.max(...t.stages.map((x) => x.vus));
    await audit(user, 'loadtest.setujui', `${t.name} -> ${t.target}: ${t.stages.length} tahap, puncak ${peak} pengguna, ${total} detik`);
    return view({ ...t, status: 'queued', approved_by: user });
  });
}

export async function cancel(id: number, user: string) {
  const t = await db().one<TestRow>('SELECT * FROM load_tests WHERE id=$1', [id]);
  if (!t) throw new HttpError(404, 'Uji beban tidak ada');
  if (t.status === 'queued') await db().exec("UPDATE load_tests SET status='cancelled', finished=$1 WHERE id=$2 AND status='queued'", [Date.now(), id]);
  else if (t.status === 'running') await db().exec('UPDATE load_tests SET cancel_requested=true WHERE id=$1', [id]);
  else throw bad('Uji tidak sedang antre atau berjalan');
  await audit(user, 'loadtest.batal', t.name);
}

// ---------- sisi runner

export interface Job { id: number; target: string; allowPublic: boolean; requests: LoadRequest[]; thinkSeconds: number; headers: Record<string, string>; stages: LoadStage[]; scrape: Array<{ label: string; url: string; metric: string }> }

/** Ambil uji berikutnya secara atomik (dua runner tidak akan mengambil uji yang sama). */
export async function claim(info: TestRow['runner']): Promise<Job | null> {
  const now = Date.now();
  const t = await db().one<TestRow>(
    "UPDATE load_tests SET status='running', started=$1, heartbeat=$1, runner=$2 WHERE id=(SELECT id FROM load_tests WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *",
    [now, info ? JSON.stringify(info) : null]
  );
  if (!t) return null;
  const headers = t.headers_enc ? (JSON.parse(open(t.headers_enc) || '{}') as Record<string, string>) : {};
  return { id: t.id, target: t.target, allowPublic: t.allow_public, requests: t.scenario.requests, thinkSeconds: t.scenario.thinkSeconds, headers, stages: t.stages, scrape: t.scrape };
}

async function running(id: number): Promise<TestRow> {
  const t = await db().one<TestRow>('SELECT * FROM load_tests WHERE id=$1', [id]);
  if (!t) throw new HttpError(404, 'Uji beban tidak ada');
  if (t.status !== 'running') throw bad(`Uji tidak sedang berjalan (status: ${t.status})`);
  return t;
}

export async function addStage(id: number, r: StageReport): Promise<{ cancel: boolean }> {
  const t = await running(id);
  await db().exec(
    `INSERT INTO load_stages(test_id,idx,vus,seconds,reqs,rps,p50,p95,p99,err_pct,gen_cpu,valid,scraped,started,ended) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (test_id, idx) DO UPDATE SET vus=EXCLUDED.vus, seconds=EXCLUDED.seconds, reqs=EXCLUDED.reqs, rps=EXCLUDED.rps, p50=EXCLUDED.p50, p95=EXCLUDED.p95, p99=EXCLUDED.p99, err_pct=EXCLUDED.err_pct, gen_cpu=EXCLUDED.gen_cpu, valid=EXCLUDED.valid, scraped=EXCLUDED.scraped, started=EXCLUDED.started, ended=EXCLUDED.ended`,
    [id, r.idx, r.vus, r.seconds, Math.round(r.reqs), r.rps, r.p50, r.p95, r.p99, r.errPct, r.genCpu, r.genCpu <= MAX_GEN_CPU, JSON.stringify(r.scraped), Math.round(r.started), Math.round(r.ended)]
  );
  await db().exec('UPDATE load_tests SET heartbeat=$1 WHERE id=$2', [Date.now(), id]);
  return { cancel: t.cancel_requested };
}

export async function heartbeat(id: number): Promise<{ cancel: boolean }> {
  const t = await running(id);
  await db().exec('UPDATE load_tests SET heartbeat=$1 WHERE id=$2', [Date.now(), id]);
  return { cancel: t.cancel_requested };
}

export async function finish(id: number, status: 'done' | 'failed' | 'cancelled', error: string): Promise<void> {
  const t = await running(id);
  await db().exec('UPDATE load_tests SET status=$1, error=$2, finished=$3 WHERE id=$4', [status, error.slice(0, 500), Date.now(), id]);
  await audit('runner', `loadtest.${status}`, `${t.name}${error ? `: ${error.slice(0, 120)}` : ''}`);
}

/** Uji yang runner-nya berhenti melapor dianggap gagal (runner mati, jaringan putus). */
export async function watchdog(now = Date.now(), staleMs = 90_000): Promise<number> {
  return db().exec("UPDATE load_tests SET status='failed', error='Runner berhenti melapor (mati atau jaringan putus)', finished=$1 WHERE status='running' AND heartbeat < $2", [now, now - staleMs]);
}

/** Uji yang masih antre/berjalan saat aplikasi dimulai ulang tetap dibiarkan: runner yang melaporkan, watchdog yang menutup bila hilang. */

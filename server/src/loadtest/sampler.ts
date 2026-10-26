// Mencatat pemakaian tiap kontainer susunan Playground dan server uji selama uji beban berjalan (docker stats lewat SSH),
// supaya analisis bottleneck bisa menunjuk komponen yang jenuh dengan bukti. Hanya untuk uji yang berasal dari susunan Playground.
// Gagal mengambil sampel tidak pernah menggagalkan uji; analisis hanya menjadi dugaan.
import { db, log } from '../context.js';
import * as Servers from '../servers.js';

export interface Parsed { services: Array<{ service: string; cpu: number; mem_mb: number; mem_limit_mb: number }>; host: { load: number; cores: number; mem_mb: number; mem_total_mb: number } | null }

const BYTES: Record<string, number> = { b: 1, kb: 1000, kib: 1024, mb: 1e6, mib: 1048576, gb: 1e9, gib: 1073741824, tb: 1e12, tib: 1099511627776 };
/** "123.4MiB" -> MB (MiB). */
export function parseMem(text: string): number {
  const m = /^\s*([\d.]+)\s*([A-Za-z]+)\s*$/.exec(text); if (!m) return 0;
  const mult = BYTES[m[2]!.toLowerCase()]; return mult ? (Number(m[1]) * mult) / 1048576 : 0;
}

/** Perintah satu kali jalan: statistik kontainer proyek, pemetaan nama kontainer ke layanan, dan beban server. Hanya membaca. */
export const command = (project: string): string =>
  `P=${project}; IDS=$(docker ps -q --filter label=com.docker.compose.project=$P); if [ -n "$IDS" ]; then docker stats --no-stream --format 'S|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' $IDS; docker ps --filter label=com.docker.compose.project=$P --format 'N|{{.Names}}|{{.Label "com.docker.compose.service"}}'; fi; echo "H|$(cut -d' ' -f1 /proc/loadavg)|$(nproc)|$(free -m | awk '/^Mem:/{print $3"|"$2}')"`;

export function parse(out: string): Parsed {
  const nameOf = new Map<string, string>(), stats: Array<{ name: string; cpu: number; used: number; limit: number }> = [];
  let host: Parsed['host'] = null;
  for (const line of out.split('\n')) {
    const f = line.trim().split('|');
    if (f[0] === 'N' && f[1]) nameOf.set(f[1], f[2] || f[1]);
    else if (f[0] === 'S' && f[1]) { const [used, limit] = (f[3] ?? '').split('/'); stats.push({ name: f[1], cpu: Number((f[2] ?? '').replace('%', '')) || 0, used: parseMem(used ?? ''), limit: parseMem(limit ?? '') }); }
    else if (f[0] === 'H') { const load = Number(f[1]), cores = Number(f[2]), used = Number(f[3]), total = Number(f[4]); if ([load, cores, used, total].every(Number.isFinite) && cores > 0) host = { load, cores, mem_mb: used, mem_total_mb: total }; }
  }
  return { services: stats.map((s) => ({ service: nameOf.get(s.name) ?? s.name, cpu: s.cpu, mem_mb: s.used, mem_limit_mb: s.limit })), host };
}

/** Satu sampel untuk satu uji. Mengembalikan jumlah baris yang disimpan. */
export async function sampleOnce(testId: number, now = Date.now()): Promise<number> {
  const t = await db().one<{ playground_id: number | null }>('SELECT playground_id FROM load_tests WHERE id=$1', [testId]);
  if (!t?.playground_id) return 0;
  const p = await db().one<{ server_id: number }>('SELECT server_id FROM playground_deploys WHERE id=$1', [t.playground_id]); if (!p) return 0;
  const server = await Servers.get(p.server_id); if (!server) return 0;
  const r = await Servers.run(server, command(`aiops-pg-${t.playground_id}`), { timeoutMs: 20_000 });
  if (r.exitCode !== 0 && !r.stdout.trim()) return 0;
  const parsed = parse(r.stdout); let n = 0;
  for (const s of parsed.services) { await db().exec('INSERT INTO load_samples(test_id,ts,service,cpu,mem_mb,mem_limit_mb) VALUES($1,$2,$3,$4,$5,$6)', [testId, now, s.service, s.cpu, s.mem_mb, s.mem_limit_mb]); n++; }
  if (parsed.host) { await db().exec("INSERT INTO load_samples(test_id,ts,service,cpu,mem_mb,mem_limit_mb,cores) VALUES($1,$2,'_host',$3,$4,$5,$6)", [testId, now, parsed.host.load, parsed.host.mem_mb, parsed.host.mem_total_mb, parsed.host.cores]); n++; }
  return n;
}

const timers = new Map<number, ReturnType<typeof setInterval>>();
let everyMs = 5000;
/** Untuk uji: ubah selang pengambilan sampel. */
export function setIntervalMs(ms: number): void { everyMs = ms; }
export const active = (testId: number): boolean => timers.has(testId);
export function stop(testId: number): void { const t = timers.get(testId); if (t) { clearInterval(t); timers.delete(testId); } }

/** Mulai mengambil sampel sampai uji tidak lagi antre atau berjalan (atau 2 jam). Aman dipanggil berulang. */
export function start(testId: number): void {
  if (timers.has(testId)) return;
  let busy = false; const until = Date.now() + 2 * 3600_000;
  const timer = setInterval(() => {
    if (busy) return; busy = true;
    void (async () => {
      try {
        const t = await db().one<{ status: string }>('SELECT status FROM load_tests WHERE id=$1', [testId]);
        if (!t || !['queued', 'running'].includes(t.status) || Date.now() > until) { stop(testId); return; }
        await sampleOnce(testId);
      } catch (e) { log().warn({ err: (e as Error).message, testId }, 'sampel pemakaian uji beban gagal'); }
      finally { busy = false; }
    })();
  }, everyMs);
  timer.unref?.(); timers.set(testId, timer);
  void sampleOnce(testId).catch(() => undefined);   // sampel pertama segera, sebelum beban naik
}

// Di mana bottleneck-nya? Dibaca dari (1) pemakaian tiap kontainer dan server selama tiap tahap bila uji berasal dari susunan Playground,
// (2) kurva hasil (lutut, dataran, error), dan (3) metrik yang dibaca dari server uji. Tanpa data per komponen, hasilnya DUGAAN dan ditandai begitu.
// Fungsi murni supaya mudah diuji; semua angka yang disebut berasal dari data ukur.
import type { Analysis, StageRow } from './analysis.js';
import { MAX_GEN_CPU } from './schema.js';
import { ROLE_LABEL, type Architecture, type Role } from './roles.js';

export interface Sample { ts: number; service: string; cpu: number; mem_mb: number; mem_limit_mb: number; cores: number }
export interface StageWindow extends StageRow { started: number; ended: number; scraped: Record<string, { avg: number; max: number; last: number }> }
export interface Limit { cpus?: number; memMb?: number }

export type Confidence = 'terukur' | 'kuat' | 'dugaan';
export interface Finding { component: string; role: Role | 'host' | 'generator' | 'tidak diketahui'; confidence: Confidence; title: string; evidence: string[]; advice: string[]; score: number }
export interface Usage { service: string; role: Role | 'host'; stages: Array<{ idx: number; vus: number; cpu: number | null; mem: number | null }> }
export interface BottleneckReport { basis: 'terukur' | 'perkiraan'; stageIdx: number | null; headline: string; findings: Finding[]; usage: Usage[]; cautions: string[] }

const pct = (n: number) => `${Math.round(n * 100)}%`;
const HOST = '_host';

/** Kapasitas pembagi untuk satu layanan: CPU terhadap batasnya (atau jumlah core server; 100 = satu core), memori terhadap batasnya (atau total memori server). */
function capsOf(lim: Limit | undefined, cores: number, hostMem: number, memLimitMb: number): { cpuCap: number; memCap: number } {
  return { cpuCap: (lim?.cpus ?? cores) * 100, memCap: lim?.memMb ?? (memLimitMb && hostMem && memLimitMb < hostMem * 0.98 ? memLimitMb : hostMem) };
}

/** Pemakaian rata-rata (0..1+) tiap layanan pada tiap tahap: CPU terhadap batas (atau core server), memori terhadap batas (atau total memori server). */
export function usage(stages: StageWindow[], samples: Sample[], arch: Architecture | null, limits: Record<string, Limit>): Usage[] {
  if (!samples.length) return [];
  const names = [...new Set(samples.map((s) => s.service))], roleOf = new Map((arch?.nodes ?? []).map((n) => [n.name, n.role] as const));
  const hostAny = samples.find((s) => s.service === HOST), cores = hostAny?.cores || 1, hostMem = hostAny?.mem_limit_mb || 0;
  return names.map((service) => ({
    service, role: service === HOST ? 'host' : roleOf.get(service) ?? 'app',
    stages: stages.map((st) => {
      const rows = samples.filter((s) => s.service === service && s.ts >= st.started && s.ts <= st.ended);
      if (!rows.length) return { idx: st.idx, vus: st.vus, cpu: null, mem: null };
      const avg = (f: (s: Sample) => number) => rows.reduce((a, s) => a + f(s), 0) / rows.length;
      if (service === HOST) return { idx: st.idx, vus: st.vus, cpu: avg((s) => s.cpu) / cores, mem: hostMem ? avg((s) => s.mem_mb) / hostMem : null };
      const { cpuCap, memCap } = capsOf(limits[service], cores, hostMem, rows[0]!.mem_limit_mb);
      return { idx: st.idx, vus: st.vus, cpu: avg((s) => s.cpu) / cpuCap, mem: memCap ? avg((s) => s.mem_mb) / memCap : null };
    })
  }));
}

export interface LiveService { service: string; role: Role | 'host'; cpuCores: number; cpu: number | null; memMb: number; mem: number | null }
/** Keadaan untuk tampilan langsung: `at` = waktu sampel terakhir; `stageIdx` = tahap yang sedang berjalan (jumlah tahap yang sudah dilaporkan); `vus` = pengguna virtual tahap itu. */
export interface Live { at: number; stageIdx: number; vus: number | null; maxVus: number; services: LiveService[]; host: { cores: number; load: number; cpu: number; mem: number | null } | null }

/** Pemakaian pada sampel terbaru (angka yang sama dengan usage(), hanya satu titik waktu) supaya diagram bisa hidup selama uji berjalan. Null bila belum ada sampel. */
export function liveUsage(samples: Sample[], plan: Array<{ vus: number }>, done: number, arch: Architecture | null, limits: Record<string, Limit>): Live | null {
  if (!samples.length) return null;
  const at = samples.reduce((m, s) => Math.max(m, s.ts), 0), rows = samples.filter((s) => s.ts === at);
  const host = rows.find((s) => s.service === HOST), cores = host?.cores || 1, hostMem = host?.mem_limit_mb || 0, roleOf = new Map((arch?.nodes ?? []).map((n) => [n.name, n.role] as const));
  return {
    at, stageIdx: done, vus: plan[done]?.vus ?? null, maxVus: plan.reduce((m, p) => Math.max(m, p.vus), 0),
    services: rows.filter((s) => s.service !== HOST).map((s) => {
      const { cpuCap, memCap } = capsOf(limits[s.service], cores, hostMem, s.mem_limit_mb);
      return { service: s.service, role: roleOf.get(s.service) ?? 'app', cpuCores: s.cpu / 100, cpu: cpuCap ? s.cpu / cpuCap : null, memMb: s.mem_mb, mem: memCap ? s.mem_mb / memCap : null };
    }),
    host: host ? { cores, load: host.cpu, cpu: host.cpu / cores, mem: hostMem ? host.mem_mb / hostMem : null } : null
  };
}

/** Rangkaian keadaan langsung dari semua sampel tersimpan, untuk memutar ulang uji yang sudah selesai. Tiap bingkai = satu waktu sampel; tahapnya diambil dari
 *  jendela waktu tahap (sampel di sela tahap atau sebelum tahap pertama dihitung ke tahap berikutnya, sesudah tahap terakhir ke tahap terakhir). Dijarangkan merata bila lebih dari `max`. */
export function replayFrames(samples: Sample[], stages: Array<{ started: number; ended: number }>, plan: Array<{ vus: number }>, arch: Architecture | null, limits: Record<string, Limit>, max = 240): Live[] {
  if (!samples.length || !plan.length) return [];
  const byTs = new Map<number, Sample[]>();
  for (const s of samples) { const g = byTs.get(s.ts); if (g) g.push(s); else byTs.set(s.ts, [s]); }
  let times = [...byTs.keys()].sort((a, b) => a - b);
  if (times.length > max) times = Array.from({ length: max }, (_, i) => times[Math.round((i * (times.length - 1)) / (max - 1))]!);
  const stageAt = (ts: number): number => {
    const inside = stages.findIndex((st) => ts >= st.started && ts <= st.ended); if (inside >= 0) return inside;
    const next = stages.findIndex((st) => st.started > ts); return next >= 0 ? next : Math.max(0, stages.length - 1);
  };
  return times.map((ts) => liveUsage(byTs.get(ts)!, plan, stageAt(ts), arch, limits)!);
}

const ADVICE: Record<Role, { cpu: string[]; mem: string[] }> = {
  db: { cpu: ['Periksa query lambat (slow query log, EXPLAIN) dan tambahkan index yang hilang.', 'Naikkan CPU database atau pisahkan ke server sendiri.', 'Bila bebannya banyak baca, tambah replika baca atau cache hasil query.'], mem: ['Naikkan memori database dan periksa buffer pool atau shared_buffers.', 'Kurangi ukuran data yang sering dibaca atau tambahkan cache di depannya.'] },
  app: { cpu: ['Tambah replika aplikasi di belakang load balancer (sebaiknya di server berbeda).', 'Profil kode pada jalur request tersering; kerjaan berat dipindah ke antrean.', 'Naikkan jumlah worker atau batas CPU kontainer.'], mem: ['Periksa kebocoran memori dan ukuran objek per request.', 'Naikkan batas memori atau kurangi worker per kontainer.'] },
  proxy: { cpu: ['Proxy jarang menjadi sumber masalah; periksa upstream di belakangnya lebih dulu.', 'Bila memang penuh: tambah worker dan aktifkan keepalive ke upstream.'], mem: ['Kurangi buffer dan jumlah koneksi menganggur.'] },
  cache: { cpu: ['Pecah ke beberapa instance atau kurangi perintah yang berat (KEYS, pemindaian besar).'], mem: ['Naikkan maxmemory dan periksa kebijakan eviction; bila penuh, hit ratio turun dan beban pindah ke database.'] },
  queue: { cpu: ['Tambah konsumen dan periksa pesan yang menumpuk.'], mem: ['Periksa antrean yang menumpuk dan batas memori broker (watermark).'] },
  vector: { cpu: ['Kurangi parameter pencarian (ef, jumlah kandidat) atau tambah CPU; pisahkan ke server sendiri.'], mem: ['Indeks vektor harus muat di memori: naikkan RAM atau pakai kuantisasi.'] },
  search: { cpu: ['Periksa query berat dan jumlah shard; tambah node.'], mem: ['Naikkan heap sesuai panduan (maks. setengah RAM) dan periksa ukuran indeks.'] }
};

/** Kurva dan gejala tanpa data per komponen: hanya dugaan, diurutkan menurut kebiasaan (database lalu aplikasi lalu proxy). */
function suspects(arch: Architecture | null, a: Analysis, stage: StageRow | undefined): Finding[] {
  const order: Role[] = ['db', 'app', 'vector', 'search', 'queue', 'cache', 'proxy'], present = (r: Role) => (arch?.nodes ?? []).filter((n) => n.role === r);
  const errors = (stage?.errPct ?? 0) > 0, plateau = !!a.plateau;
  const sym = errors ? `error ${stage!.errPct.toFixed(1)}%` : plateau ? `throughput mendatar di ${a.plateau!.rps.toFixed(1)} req/dtk` : 'waktu respons naik';
  const out: Finding[] = [];
  const roles = arch ? order.filter((r) => present(r).length) : [];
  roles.slice(0, 3).forEach((r, i) => out.push({
    component: present(r).map((n) => n.name).join(', '), role: r, confidence: 'dugaan', score: 40 - i * 10,
    title: `${ROLE_LABEL[r]} kemungkinan menjadi penyempit`,
    evidence: [`Gejala: ${sym}. Tanpa pemakaian per komponen, ini perkiraan dari gejalanya, bukan bukti.`],
    advice: [...ADVICE[r].cpu.slice(0, 2), 'Jalankan uji dari susunan Playground supaya pemakaian tiap komponen terukur dan dugaan ini bisa dibuktikan atau dibantah.']
  }));
  if (!arch) out.push({ component: 'tidak diketahui', role: 'tidak diketahui', confidence: 'dugaan', score: 20, title: 'Komponen yang menyempit belum bisa ditentukan', evidence: [`Gejala: ${sym}.`, 'Uji ini tidak berasal dari susunan Playground, jadi isi arsitektur dan pemakaian tiap komponen tidak diketahui.'], advice: ['Pasang susunan lewat Playground lalu uji dari sana, atau isi metrik server uji di formulir (CPU, koneksi, antrean).'] });
  return out;
}

export function bottleneck(input: { stages: StageWindow[]; analysis: Analysis; samples: Sample[]; arch: Architecture | null; limits: Record<string, Limit> }): BottleneckReport {
  const { stages, analysis: a, samples, arch, limits } = input, rows = [...stages].sort((x, y) => x.idx - y.idx);
  const use = usage(rows, samples, arch, limits), measured = use.some((u) => u.stages.some((s) => s.cpu !== null));
  const cautions: string[] = [];
  if (!rows.length) return { basis: 'perkiraan', stageIdx: null, headline: 'Belum ada hasil untuk dianalisis.', findings: [], usage: use, cautions };
  const focus = a.knee ? rows.find((s) => s.idx === a.knee!.idx)! : rows[rows.length - 1]!, findings: Finding[] = [];
  if (a.invalidStages.length) cautions.push(`Pembangkit beban memakai CPU lebih dari ${pct(MAX_GEN_CPU)} pada tahap ${a.invalidStages.map((i) => i + 1).join(', ')}: yang jenuh mungkin pembangkit, bukan sistem Anda.`);
  if (a.invalidStages.includes(focus.idx)) findings.push({ component: 'pembangkit beban', role: 'generator', confidence: 'terukur', score: 90, title: 'Pembangkit beban sendiri jenuh pada tahap ini', evidence: [`CPU pembangkit ${pct(focus.genCpu)} pada tahap ${focus.idx + 1}.`], advice: ['Turunkan jumlah pengguna per tahap, atau beri runner lebih banyak CPU, lalu ulangi.'] });

  if (measured) {
    for (const u of use) {
      const st = u.stages.find((s) => s.idx === focus.idx); if (!st) continue;
      const cpu = st.cpu ?? 0, mem = st.mem ?? 0, top = Math.max(cpu, mem), first = u.stages.find((s) => s.cpu !== null);
      if (top < 0.6) continue;
      const kind = cpu >= mem ? 'CPU' : 'memori', val = cpu >= mem ? cpu : mem;
      const trend = first && first.idx !== focus.idx && first.cpu !== null ? `; pada tahap ${first.idx + 1} (${first.vus} pengguna) baru ${pct(cpu >= mem ? first.cpu : first.mem ?? 0)}` : '';
      if (u.role === 'host') findings.push({ component: 'server uji', role: 'host', confidence: top >= 0.85 ? 'terukur' : 'kuat', score: 70 + top * 20, title: top >= 0.85 ? 'Server uji penuh: komponen berebut sumber daya yang sama' : 'Server uji hampir penuh', evidence: [`${kind === 'CPU' ? 'Load average per core' : 'Memori terpakai'} ${pct(val)} pada tahap ${focus.idx + 1} (${focus.vus} pengguna)${trend}.`, 'Semua komponen di server ini berbagi CPU, memori, dan disk yang sama.'], advice: ['Pisahkan komponen ke server berbeda: lihat bagian Penempatan, mulai dari database.', 'Naikkan kapasitas server uji bila memang ingin tetap satu server.'] });
      else findings.push({ component: u.service, role: u.role as Role, confidence: top >= 0.85 ? 'terukur' : 'kuat', score: 60 + top * 30, title: top >= 0.85 ? `${u.service} jenuh (${kind} ${pct(val)})` : `${u.service} mendekati jenuh (${kind} ${pct(val)})`, evidence: [`${kind} ${pct(val)} dari kapasitasnya pada tahap ${focus.idx + 1} (${focus.vus} pengguna)${trend}.`, ...(a.knee ? [`Tahap ini adalah lutut: ${a.knee.reason}.`] : [])], advice: ADVICE[u.role as Role][kind === 'CPU' ? 'cpu' : 'mem'] });
    }
    const hot = findings.filter((f) => f.role !== 'host' && f.role !== 'generator' && f.confidence === 'terukur').length;
    if (findings.some((f) => f.role === 'host' && f.confidence === 'terukur') && hot >= 1) cautions.push('Server uji penuh dan lebih dari satu komponen ikut tinggi: angka tiap komponen saling memengaruhi. Pisahkan ke server berbeda lalu ukur lagi untuk melihat penyempit sebenarnya.');
  }
  // Sehat sampai beban tertinggi: tetap sebut komponen yang paling terpakai, karena dialah yang jenuh lebih dulu bila beban naik
  if (measured && !a.knee && !a.plateau && !findings.some((f) => f.role !== 'generator' && f.confidence === 'terukur')) {
    const best = use.filter((u) => u.role !== 'host').map((u) => { const st = u.stages.find((s) => s.idx === focus.idx); const cpu = st?.cpu ?? 0, mem = st?.mem ?? 0; return { u, cpu, mem, top: Math.max(cpu, mem) }; }).sort((x, y) => y.top - x.top)[0];
    if (best && best.top > 0 && !findings.some((f) => f.component === best.u.service)) {
      const kind = best.cpu >= best.mem ? 'CPU' : 'memori', role = best.u.role as Role;
      findings.push({ component: best.u.service, role, confidence: 'kuat', score: 30 + best.top * 20, title: `${best.u.service} paling terpakai (${kind} ${pct(best.top)})`,
        evidence: [`${kind} ${pct(best.top)} dari kapasitasnya pada beban tertinggi yang diuji (${focus.vus} pengguna).`, `Kasarnya masih ada sisa sekitar ${(1 / best.top).toFixed(1)}x beban ini sebelum penuh, dengan anggapan pemakaiannya naik sebanding dengan beban.`],
        advice: ['Naikkan tahap beban di uji berikutnya sampai kriteria terlanggar untuk melihat apakah komponen ini memang yang pertama jenuh.', ...ADVICE[role][kind === 'CPU' ? 'cpu' : 'mem'].slice(0, 1)] });
    }
  }
  // metrik server uji yang dibaca runner: yang naik tajam antara tahap pertama dan tahap fokus
  const first = rows[0]!;
  for (const [label, m] of Object.entries(focus.scraped)) {
    const base = first.scraped[label]?.avg;
    if (base !== undefined && first.idx !== focus.idx && base > 0 && m.avg / base >= 2) findings.push({ component: label, role: 'tidak diketahui', confidence: 'kuat', score: 50, title: `Metrik "${label}" naik ${(m.avg / base).toFixed(1)}x`, evidence: [`Rata-rata ${base.toFixed(1)} pada tahap ${first.idx + 1} menjadi ${m.avg.toFixed(1)} pada tahap ${focus.idx + 1} (puncak ${m.max.toFixed(1)}).`], advice: ['Metrik yang naik bersama beban menunjukkan komponen yang bekerja paling keras; cocokkan dengan komponen yang memakainya.'] });
  }
  if (!measured && (a.knee || a.plateau)) findings.push(...suspects(arch, a, focus));

  findings.sort((x, y) => y.score - x.score);
  const top = findings[0], healthy = !a.knee && !a.plateau;
  let headline: string;
  if (!findings.length) headline = healthy ? 'Belum ada bottleneck pada beban ini: semua tahap sehat dan tidak ada komponen yang mendekati penuh.' : 'Belum bisa menentukan komponen yang menyempit.';
  else if (healthy) headline = `Belum ada bottleneck pada beban ini. Komponen yang paling terpakai dan kemungkinan pertama jenuh bila beban naik: ${top!.component}.`;
  else headline = `${top!.title}${top!.confidence === 'dugaan' ? ' (dugaan, belum terbukti)' : ''}.`;
  return { basis: measured ? 'terukur' : 'perkiraan', stageIdx: focus.idx, headline, findings: findings.slice(0, 6), usage: use, cautions };
}

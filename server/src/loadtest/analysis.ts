// Membaca hasil uji bertahap: tahap mana yang masih sehat, di mana mulai tidak sehat ("lutut"), dan apakah throughput mendatar.
// Fungsi murni supaya mudah diuji. Semua angka berasal dari hasil ukur runner, tidak ada tebakan.
import type { Criteria } from './schema.js';
import { MAX_GEN_CPU } from './schema.js';

export interface StageRow { idx: number; vus: number; seconds: number; rps: number; p95: number; errPct: number; genCpu: number; valid: boolean }

export interface Analysis {
  /** Tahap terakhir yang memenuhi kriteria, atau null bila sejak tahap pertama sudah tidak sehat. */
  healthy: { idx: number; vus: number; rps: number } | null;
  /** Tahap pertama yang melanggar kriteria. */
  knee: { idx: number; vus: number; rps: number; reason: string } | null;
  /** Throughput berhenti naik walau pengguna bertambah: sistem sudah jenuh. */
  plateau: { fromVus: number; rps: number } | null;
  invalidStages: number[];
  verdict: { tone: 'ok' | 'warn' | 'bad' | 'mute'; title: string; text: string };
}

const fmt = (n: number, d = 0) => n.toFixed(d);

export function breaches(s: StageRow, c: Criteria): string[] {
  const out: string[] = [];
  if (s.p95 > c.p95Ms) out.push(`p95 ${fmt(s.p95)} ms melebihi batas ${fmt(c.p95Ms)} ms`);
  if (s.errPct > c.errPct) out.push(`error ${fmt(s.errPct, 1)}% melebihi batas ${fmt(c.errPct, 1)}%`);
  return out;
}

export function analyze(stages: StageRow[], c: Criteria, finished: boolean): Analysis {
  const rows = [...stages].sort((a, b) => a.idx - b.idx);
  const invalid = rows.filter((s) => !s.valid || s.genCpu > MAX_GEN_CPU).map((s) => s.idx);
  let healthy: Analysis['healthy'] = null, knee: Analysis['knee'] = null;
  for (const s of rows) {
    const b = breaches(s, c);
    if (b.length) { knee = { idx: s.idx, vus: s.vus, rps: s.rps, reason: b.join('; ') }; break; }
    healthy = { idx: s.idx, vus: s.vus, rps: s.rps };
  }
  // dataran: pengguna naik minimal 1,5x tetapi throughput naik kurang dari 5%
  let plateau: Analysis['plateau'] = null;
  for (let i = 1; i < rows.length && !plateau; i++) {
    const a = rows[i - 1]!, b = rows[i]!;
    if (b.vus >= a.vus * 1.5 && a.rps > 0 && b.rps < a.rps * 1.05) plateau = { fromVus: a.vus, rps: b.rps };
  }
  let verdict: Analysis['verdict'];
  if (!rows.length) verdict = { tone: 'mute', title: 'Belum ada hasil', text: 'Hasil tiap tahap muncul di sini begitu runner melaporkannya.' };
  else if (invalid.length) verdict = { tone: 'warn', title: 'Sebagian hasil tidak murni', text: `Pembangkit beban memakai CPU lebih dari ${Math.round(MAX_GEN_CPU * 100)}% pada tahap ${invalid.map((i) => i + 1).join(', ')}, jadi yang jenuh mungkin pembangkitnya, bukan server uji. Beri pembangkit lebih banyak CPU atau pindahkan ke mesin lain, lalu ulangi.` };
  else if (knee && !healthy) verdict = { tone: 'bad', title: 'Tidak sehat sejak tahap pertama', text: `Pada ${knee.vus} pengguna sudah melanggar kriteria: ${knee.reason}. Turunkan beban awal untuk menemukan kapasitasnya.` };
  else if (knee && healthy) verdict = { tone: 'warn', title: `Sehat sampai ${healthy.vus} pengguna (≈ ${fmt(healthy.rps, 1)} req/dtk), mulai tidak sehat di ${knee.vus}`, text: `Tahap ${knee.idx + 1}: ${knee.reason}.${plateau ? ` Throughput mendatar di ≈ ${fmt(plateau.rps, 1)} req/dtk sejak ${plateau.fromVus} pengguna: sistem sudah jenuh.` : ''} Lihat metrik server uji di tahap itu untuk mencari komponen yang jenuh.` };
  else if (healthy) verdict = { tone: 'ok', title: `Semua tahap sehat sampai ${healthy.vus} pengguna (≈ ${fmt(healthy.rps, 1)} req/dtk)`, text: finished ? 'Kriteria tidak terlanggar pada beban tertinggi yang diuji. Naikkan tahap berikutnya untuk menemukan batasnya.' : 'Uji masih berjalan.' };
  else verdict = { tone: 'mute', title: 'Belum ada hasil', text: '' };
  return { healthy, knee, plateau, invalidStages: invalid, verdict };
}

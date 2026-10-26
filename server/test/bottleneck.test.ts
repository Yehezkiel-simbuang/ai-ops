// Analisis bottleneck: bukti terukur per komponen bila ada, dugaan yang ditandai bila tidak; semua dari data, tanpa tebakan tersembunyi.
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/loadtest/analysis.js';
import { bottleneck, usage, type Sample, type StageWindow } from '../src/loadtest/bottleneck.js';
import { architecture, type SvcIn } from '../src/loadtest/roles.js';

const T0 = 1_000_000, CRIT = { p95Ms: 500, errPct: 1 };
const stage = (idx: number, vus: number, over: Partial<StageWindow> = {}): StageWindow => ({ idx, vus, seconds: 30, rps: vus * 2, p95: 100, errPct: 0, genCpu: 0.2, valid: true, started: T0 + idx * 40_000, ended: T0 + idx * 40_000 + 30_000, scraped: {}, ...over });
const services: SvcIn[] = [{ name: 'web', image: 'nginx:1.27', published: true }, { name: 'api', image: 'x/api:1' }, { name: 'db', image: 'postgres:17' }, { name: 'cache', image: 'redis:7' }];
const arch = architecture(services);
/** Sampel tiap 5 detik di dalam jendela tiap tahap. cpu = persen CPU docker (100 = satu core). */
const samples = (per: Record<string, number[]>, host?: { load: number[]; mem: number[] }): Sample[] => {
  const out: Sample[] = [];
  for (let i = 0; i < 3; i++) for (let k = 0; k < 5; k++) {
    const ts = T0 + i * 40_000 + 2_000 + k * 5_000;
    for (const [service, cpu] of Object.entries(per)) out.push({ ts, service, cpu: cpu[i]!, mem_mb: 100, mem_limit_mb: 0, cores: 0 });
    if (host) out.push({ ts, service: '_host', cpu: host.load[i]!, mem_mb: host.mem[i]!, mem_limit_mb: 1000, cores: 2 });
  }
  return out;
};
const run = (stages: StageWindow[], sm: Sample[], limits = {}) => bottleneck({ stages, analysis: analyze(stages, CRIT, true), samples: sm, arch, limits });
const kneeStages = [stage(0, 10), stage(1, 40), stage(2, 80, { p95: 900, rps: 90 })];   // lutut di tahap 3

describe('pemakaian per komponen', () => {
  it('CPU dinormalkan terhadap batas layanan (bila ada) atau jumlah core server; memori terhadap batas atau total server', () => {
    const sm = samples({ db: [50, 100, 200], api: [20, 40, 50] }, { load: [0.5, 1, 1.9], mem: [300, 500, 600] });
    const u = usage(kneeStages, sm, arch, { db: { cpus: 0.5 } });
    expect(u.find((x) => x.service === 'db')!.stages.map((s) => s.cpu)).toEqual([1, 2, 4]);   // 50% dari 0,5 core = 100%
    expect(u.find((x) => x.service === 'api')!.stages.map((s) => Math.round(s.cpu! * 100))).toEqual([10, 20, 25]);   // dibagi 2 core
    expect(u.find((x) => x.service === '_host')!.stages.map((s) => Math.round(s.cpu! * 100))).toEqual([25, 50, 95]); expect(u.find((x) => x.service === 'db')!.role).toBe('db');
  });
  it('tanpa sampel: kosong', () => { expect(usage(kneeStages, [], arch, {})).toEqual([]); });
});

describe('bottleneck terukur', () => {
  it('database yang jenuh pada tahap lutut ditunjuk sebagai penyempit, dengan bukti angka dan tren, dan saran khas database', () => {
    const r = run(kneeStages, samples({ db: [30, 90, 190], api: [20, 40, 70], web: [5, 10, 15], cache: [2, 3, 4] }, { load: [0.4, 1, 1.5], mem: [300, 400, 500] }));
    expect(r.basis).toBe('terukur'); expect(r.stageIdx).toBe(2);
    const top = r.findings[0]!; expect(top).toMatchObject({ component: 'db', role: 'db', confidence: 'terukur' });
    expect(top.title).toMatch(/db jenuh \(CPU 95%\)/); expect(top.evidence.join(' ')).toMatch(/tahap 3 \(80 pengguna\).*tahap 1 \(10 pengguna\) baru 15%/); expect(top.evidence.join(' ')).toMatch(/lutut/);
    expect(top.advice.join(' ')).toMatch(/index|query lambat/); expect(r.headline).toMatch(/db jenuh/);
  });

  it('server uji yang penuh dengan beberapa komponen tinggi: temuan server dan peringatan bahwa angka komponen saling memengaruhi; saran memisahkan', () => {
    const r = run(kneeStages, samples({ db: [30, 90, 180], api: [20, 100, 180] }, { load: [0.5, 1.6, 2], mem: [300, 400, 500] }));
    const host = r.findings.find((f) => f.role === 'host')!; expect(host).toMatchObject({ confidence: 'terukur' }); expect(host.advice.join(' ')).toMatch(/Pisahkan komponen ke server berbeda/);
    expect(r.cautions.join(' ')).toMatch(/saling memengaruhi/);
  });

  it('komponen di bawah 60% tidak dituduh; sehat sampai beban tertinggi: tidak ada bottleneck, tetapi disebut yang paling terpakai', () => {
    const st = [stage(0, 10), stage(1, 40), stage(2, 80)];
    const r = run(st, samples({ db: [10, 20, 30], api: [20, 60, 100], web: [5, 5, 5] }, { load: [0.2, 0.5, 0.8], mem: [300, 400, 500] }));
    expect(r.headline).toMatch(/Belum ada bottleneck pada beban ini/); expect(r.findings.every((f) => f.confidence !== 'terukur')).toBe(true); expect(r.findings.some((f) => f.component === 'db')).toBe(false);
    expect(r.findings[0]!.component).toBe('api'); expect(r.findings[0]!.title).toMatch(/paling terpakai \(CPU 50%\)/); expect(r.findings[0]!.evidence.join(' ')).toMatch(/sisa sekitar 2\.0x/);
    expect(r.headline).toMatch(/kemungkinan pertama jenuh bila beban naik: api/);
  });

  it('pembangkit beban yang jenuh pada tahap fokus ditandai, dan hasilnya diberi peringatan tidak murni', () => {
    const st = [stage(0, 10), stage(1, 40), stage(2, 80, { p95: 900, genCpu: 0.95, valid: false })];
    const r = run(st, samples({ db: [10, 20, 30], api: [20, 40, 50] }));
    expect(r.findings[0]).toMatchObject({ role: 'generator', component: 'pembangkit beban' }); expect(r.cautions.join(' ')).toMatch(/pembangkit/);
  });
});

describe('tanpa data per komponen: dugaan yang diberi label', () => {
  it('lutut tanpa sampel: dugaan berurutan (database dulu), berlabel dugaan, dan menyarankan menjalankan uji dari Playground', () => {
    const r = run(kneeStages, []);
    expect(r.basis).toBe('perkiraan'); expect(r.findings.length).toBeGreaterThan(0); expect(r.findings.every((f) => f.confidence === 'dugaan')).toBe(true);
    expect(r.findings[0]!.role).toBe('db'); expect(r.headline).toMatch(/dugaan, belum terbukti/); expect(r.findings[0]!.advice.join(' ')).toMatch(/Playground/);
    expect(r.findings[0]!.evidence.join(' ')).toMatch(/bukan bukti/);
  });
  it('tanpa arsitektur (uji bukan dari Playground): satu temuan jujur bahwa komponen tidak bisa ditentukan', () => {
    const r = bottleneck({ stages: kneeStages, analysis: analyze(kneeStages, CRIT, true), samples: [], arch: null, limits: {} });
    expect(r.findings).toHaveLength(1); expect(r.findings[0]).toMatchObject({ role: 'tidak diketahui', confidence: 'dugaan' }); expect(r.findings[0]!.evidence.join(' ')).toMatch(/bukan dari susunan Playground|tidak berasal dari susunan Playground/);
  });
  it('dataran throughput dan error disebut sebagai gejala; sehat tanpa data: tidak ada temuan', () => {
    const st = [stage(0, 10, { rps: 20 }), stage(1, 40, { rps: 21, errPct: 3, p95: 700 })];
    expect(run(st, []).findings[0]!.evidence.join(' ')).toMatch(/error 3\.0%/);
    const ok = run([stage(0, 10), stage(1, 20)], []); expect(ok.findings).toEqual([]); expect(ok.headline).toMatch(/Belum ada bottleneck/);
  });
  it('tanpa hasil sama sekali: tidak ada analisis', () => { expect(run([], []).headline).toMatch(/Belum ada hasil/); });
});

describe('metrik server uji', () => {
  it('metrik yang naik dua kali lipat atau lebih antara tahap pertama dan tahap fokus dilaporkan', () => {
    const st = [stage(0, 10, { scraped: { pool: { avg: 2, max: 3, last: 2 } } }), stage(1, 40), stage(2, 80, { p95: 900, scraped: { pool: { avg: 9, max: 10, last: 10 } } })];
    const f = run(st, []).findings.find((x) => x.component === 'pool')!; expect(f).toBeTruthy(); expect(f.title).toMatch(/naik 4\.5x/); expect(f.evidence.join(' ')).toMatch(/tahap 1 menjadi 9\.0 pada tahap 3/);
  });
});

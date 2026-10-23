import { run, summary } from './fixtures';
import { compareRuns, verdictOf } from './verdict';

const withSummary = (s: ReturnType<typeof summary>) => run({ summary: s });

describe('compareRuns', () => {
  it('menandai lebih baik/buruk menurut arah tiap metrik, dan sama bila selisih kecil', () => {
    const rows = compareRuns(summary({ fastPct: 20, e504: 500, p95: 12 }), summary({ fastPct: 99, e504: 0, p95: 0.3 }));
    const by = Object.fromEntries(rows.map((r) => [r.key, r.verdict]));
    expect(by).toMatchObject({ fastPct: 'better', e504: 'better', p95: 'better' });
    const worse = compareRuns(summary({ fastPct: 99 }), summary({ fastPct: 60 })).find((r) => r.key === 'fastPct')!;
    expect(worse.verdict).toBe('worse'); expect(worse.delta).toBe(-39);
    expect(compareRuns(summary({ fastPct: 99 }), summary({ fastPct: 99.1 })).find((r) => r.key === 'fastPct')!.verdict).toBe('same');
  });
});

describe('verdict ketahanan (dengan skenario kegagalan)', () => {
  const fail = { node: 'pg', label: 'Postgres', at: 30, len: 40, skipped: null };
  const down = (out: number, extra: Partial<ReturnType<typeof summary>> = {}) => run({ failure: fail, summary: summary({ outageSeconds: out, degradedSeconds: out, okPct: 100 - out / 2, ...extra }) });
  it('tabel menambah baris detik mati/terganggu hanya bila ada kegagalan', () => {
    expect(compareRuns(summary(), summary()).map((r) => r.key)).not.toContain('outageSeconds');
    const rows = compareRuns(summary({ outageSeconds: 40 }), summary({ outageSeconds: 20 }), true);
    expect(rows.find((r) => r.key === 'outageSeconds')).toMatchObject({ verdict: 'better', delta: -20 });
  });
  it('HA mempersingkat gangguan: hijau, menyebut detik dan risiko data (asinkron)', () => {
    const v = verdictOf(down(40), down(20, { ha: [{ db: 'Postgres', failoverS: 20, sync: false, lagMs: 200, writesPerSec: 50, rpoTx: 10 }] }), true);
    expect(v.tone).toBe('ok'); expect(v.title).toContain('20 dtk lebih singkat'); expect(v.text).toContain('sekitar 10 transaksi');
  });
  it('replikasi sinkron: tidak ada transaksi hilang', () => {
    const v = verdictOf(down(40), down(20, { ha: [{ db: 'Postgres', failoverS: 20, sync: true, lagMs: 0, writesPerSec: 50, rpoTx: 0 }] }), true);
    expect(v.text).toContain('tidak ada transaksi yang hilang');
  });
  it('tanpa perubahan: menunjuk titik kegagalan tunggal dan apa yang perlu ditambah; perubahan yang tidak membantu: peringatan', () => {
    expect(verdictOf(down(40), down(40), false).text).toMatch(/titik kegagalan tunggal.*load balancer.*Database HA/);
    expect(verdictOf(down(40), down(38), true).title).toBe('Ketahanan tidak berubah');
  });
  it('lebih lama mati: merah; target yang tak bisa dimatikan: kembali ke verdict performa', () => {
    expect(verdictOf(down(10), down(40), true).tone).toBe('bad');
    const skipped = run({ failure: { ...fail, skipped: 'tidak bisa dimatikan' }, summary: summary({ fastPct: 20 }) });
    expect(verdictOf(skipped, run({ summary: summary({ fastPct: 99 }) }), true).tone).toBe('ok');
  });
});

describe('verdictOf', () => {
  const sick = withSummary(summary({ fastPct: 16, e504: 100 })), healthy = withSummary(summary({ fastPct: 99.6 }));
  it('tanpa perubahan: tidak menyimpulkan apa pun', () => expect(verdictOf(sick, sick, false).tone).toBe('mute'));
  it('perbaikan besar: hijau, menyebut dari-ke', () => {
    const v = verdictOf(sick, healthy, true);
    expect(v.tone).toBe('ok'); expect(v.title).toContain('+83.6'); expect(v.text).toContain('16.0%');
  });
  it('lebih buruk: merah', () => expect(verdictOf(healthy, sick, true).tone).toBe('bad'));
  it('tidak berubah dan sudah sehat: saran menaikkan beban', () => {
    const v = verdictOf(healthy, healthy, true); expect(v.tone).toBe('warn'); expect(v.text).toMatch(/Naikkan beban/);
  });
  it('tidak berubah dan masih sakit: leher botol tidak tersentuh, sebut penyebab berikutnya', () => {
    const exp = run({ summary: summary({ fastPct: 17 }) }, { diag: 1 });
    const v = verdictOf(sick, exp, true); expect(v.text).toMatch(/tidak menyentuh leher botol/); expect(v.text).toContain('SSD (fsync) menahan commit');
  });
});

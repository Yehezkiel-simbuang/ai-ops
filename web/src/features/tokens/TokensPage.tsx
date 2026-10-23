import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { q } from '@/api/queries';
import type { UsageBucket, UsageSummary } from '@/api/types';
import { Async } from '@/components/ui/Async';
import { DataTable } from '@/components/ui/DataTable';
import { DayBars, Key } from '@/components/ui/Charts';
import { PageHead, Tile, Tiles } from '@/components/ui/Layout';
import { IconChart, IconCpu, IconPulse, IconScale, IconTimer } from '@/components/icons';
import { dateTime, fmt, usd } from '@/lib/format';

const PERIODS: Array<[number, string]> = [[1, '24 jam'], [7, '7 hari'], [30, '30 hari'], [90, '90 hari']];
const ROLE_NAMES: Record<string, string> = { setup: 'Setup server', monitor: 'Monitoring' };
const SUMMARY_HEADS = ['', 'masuk', 'keluar', 'panggilan', 'biaya'];
const bucketRow = (name: string, b: UsageBucket) => [name, fmt(b.input), fmt(b.output), fmt(b.calls), usd(b.cost, b.costKnown)];

/** Hari-hari terakhir (maks. 30) dalam urutan naik, memakai tanggal UTC seperti di server. */
function lastDays(u: UsageSummary) {
  const out = [];
  for (let i = Math.min(u.days, 30) - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10), o = u.byDay[day];
    out.push({ day, input: o?.input ?? 0, output: o?.output ?? 0 });
  }
  return out;
}

function Usage({ u }: { u: UsageSummary }) {
  const t = u.total;
  return (
    <>
      <Tiles>
        <Tile value={fmt(t.input)} label="token masuk" />
        <Tile value={fmt(t.output)} label="token keluar" />
        <Tile value={fmt(t.calls)} label="panggilan" />
        <Tile value={t.calls ? usd(t.cost, t.costKnown) : '-'} label={t.costKnown || !t.calls ? 'perkiraan biaya' : 'biaya (isi harga di Pengaturan)'} />
      </Tiles>
      <div className="cols sec">
        <div className="panel"><h2><IconScale size={16} aria-hidden />Per peran</h2><DataTable heads={SUMMARY_HEADS} rows={Object.entries(u.byRole).map(([k, b]) => bucketRow(ROLE_NAMES[k] ?? k, b))} empty="Belum ada panggilan." /></div>
        <div className="panel"><h2><IconCpu size={16} aria-hidden />Per model</h2><DataTable heads={SUMMARY_HEADS} rows={Object.entries(u.byModel).map(([k, b]) => bucketRow(k, b))} empty="Belum ada panggilan." /></div>
      </div>
      <div className="panel sec">
        <h2><IconTimer size={16} aria-hidden />Per hari</h2>
        <DayBars days={lastDays(u)} label="Token per hari" />
        <div className="row lbl" style={{ marginTop: 8 }}><Key color="var(--c-in)">masuk</Key><Key color="var(--c-out)">keluar</Key></div>
      </div>
      <div className="panel sec">
        <h2><IconPulse size={16} aria-hidden />Panggilan terakhir</h2>
        <DataTable textCols={3} heads={['waktu', 'peran', 'model', 'masuk', 'keluar', 'biaya']} empty="Belum ada panggilan."
          rows={u.recent.map((r) => [dateTime(r.ts), ROLE_NAMES[r.role] ?? r.role, `${r.provider}/${r.model}`, fmt(r.input), fmt(r.output), r.cost == null ? '-' : usd(r.cost, true)])} />
      </div>
    </>
  );
}

export function TokensPage() {
  const [days, setDays] = useState(30), query = useQuery(q.usage(days));
  return (
    <>
      <PageHead title="Pemakaian token" icon={IconChart}>
        <select aria-label="Periode" value={days} onChange={(e) => setDays(Number(e.target.value))}>{PERIODS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
      </PageHead>
      <Async query={query}>{(u) => <Usage u={u} />}</Async>
    </>
  );
}

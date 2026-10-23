// Monitor satu server, disusun menurut prioritas: vonis keseluruhan, masalah yang perlu ditangani, lalu rincian yang dilipat.
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { q, useAction } from '@/api/queries';
import type { MonitorView } from '@/api/types';
import { LevelBadge, ServerStatusBadge } from '@/components/StatusBadges';
import { VerdictBanner } from '@/components/VerdictBanner';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Fold } from '@/components/ui/Fold';
import { Empty, Item, List, PageHead, Section } from '@/components/ui/Layout';
import { IconBell, IconBulb, IconPulse, IconRefresh } from '@/components/icons';
import { post } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { ChecksPanel } from './ChecksPanel';
import { isProblem, summarize, type Problem } from './health';

function ProblemList({ items, onAck }: { items: Problem[]; onAck: (alertId: number) => unknown }) {
  return (
    <List>{items.map((p) => (
      <Item key={p.id} top title={p.title} sub={[`${p.detail}${p.ts ? ` | ${ago(p.ts)}` : ''}`]}>
        <LevelBadge level={p.level} />
        {p.unconfirmed && <Badge tone="mute">belum dikonfirmasi</Badge>}
        {p.alertId !== undefined && !p.acked && <Button onClick={() => onAck(p.alertId!)}>Tandai dilihat</Button>}
        {p.acked && <Badge tone="mute">sudah dilihat</Badge>}
      </Item>
    ))}</List>
  );
}

function MonitorBody({ id, d }: { id: number; d: MonitorView }) {
  const s = d.server, refresh = [['servers', id, 'monitor'], ['overview'], ['servers']], sum = summarize(d);
  const ack = useAction((alertId: number) => post(`/api/alerts/${alertId}/ack`), { invalidate: refresh });
  const checksBad = d.checks.filter(isProblem).length;

  return (
    <>
      <VerdictBanner label="Kondisi server" verdict={sum.verdict} headline={sum.headline} detail={sum.detail}
        facts={<>{d.checks.length > 0 && `${sum.counts.ok} normal${sum.counts.minor ? `, ${sum.counts.minor} Minor` : ''}${sum.counts.major ? `, ${sum.counts.major} Major` : ''}${sum.counts.crit ? `, ${sum.counts.crit} Critical` : ''}${sum.counts.off ? `, ${sum.counts.off} dimatikan` : ''} | `}terakhir terlihat {ago(s.last_seen)}{s.os_info ? ` | ${s.os_info}` : ''}</>} />

      <Section title={sum.urgent.length ? `Perlu ditangani (${sum.urgent.length})` : 'Perlu ditangani'} icon={IconBell}>
        {sum.urgent.length ? <ProblemList items={sum.urgent} onAck={(id) => ack.mutateAsync(id)} /> : <p className="lbl calm">Tidak ada yang perlu ditangani sekarang.</p>}
      </Section>
      {sum.minor.length > 0 && <Fold title="Minor" hint={`${sum.minor.length} | lihat kalau sempat`}><ProblemList items={sum.minor} onAck={(id) => ack.mutateAsync(id)} /></Fold>}
      {sum.info.length > 0 && <Fold title="Info" hint={`${sum.info.length} | hanya jejak, tanpa tindakan`}><ProblemList items={sum.info} onAck={(id) => ack.mutateAsync(id)} /></Fold>}

      <Fold title="Pemeriksaan layanan di dalam server" hint={d.checks.length ? `${d.checks.length} pemeriksaan${checksBad ? `, ${checksBad} tidak normal` : ', semua normal'}` : 'belum ada'} open={d.checks.length === 0}>
        <ChecksPanel serverId={id} checks={d.checks} />
      </Fold>
      <Fold title="Riwayat peringatan" hint={sum.history.length ? `${sum.history.length} sudah selesai` : 'belum ada'}>
        {sum.history.length
          ? <List>{sum.history.slice(0, 20).map((a) => <Item key={a.id} title={a.title} sub={[`${a.detail} | ${ago(a.ts)}`]}><Badge tone="ok">selesai</Badge></Item>)}</List>
          : <Empty>Belum ada peringatan yang selesai.</Empty>}
      </Fold>
      <Fold title="Laporan AI" hint={d.reports.length ? `terakhir ${ago(d.reports[0]!.ts)}` : 'belum ada'} open={d.reports.length > 0 && Date.now() - d.reports[0]!.ts < 30 * 60_000}>
        {d.reports.length
          ? <div className="reports">{d.reports.map((r) => <div key={r.ts}><div className="lbl">{dateTime(r.ts)}</div><div className="report">{r.text}</div></div>)}</div>
          : <Empty>Belum ada laporan. Tekan "Analisis AI" setelah ada data metrik.</Empty>}
        <p className="lbl" style={{ marginTop: 8 }}>Ringkasan ditulis AI dari 5 metrik dasar dan peringatan aktif 2 jam terakhir. Ini bantuan membaca, bukan sumber peringatan.</p>
      </Fold>
      <p className="lbl" style={{ marginTop: 14 }}><Link to="/standar">Batas peringatan diatur di Standar pemantauan</Link> dan berlaku untuk semua server.</p>
    </>
  );
}

export function MonitorPage() {
  const servers = useQuery(q.servers()), params = useParams(), navigate = useNavigate();
  const list = servers.data;
  const id = Number(params.id) || list?.[0]?.id;
  const view = useQuery({ ...q.monitor(id ?? 0), enabled: !!id });
  const refresh = [['servers', id ?? 0, 'monitor'], ['overview'], ['servers']];
  const check = useAction(() => post<{ ok: boolean }>(`/api/servers/${id}/check`), { invalidate: refresh, onSuccess: (r) => toast(r.ok ? 'Pemeriksaan selesai' : 'Server tidak terjangkau', !r.ok) });
  const analyze = useAction(() => { toast('Menganalisis...'); return post(`/api/servers/${id}/analyze`); }, { success: 'Laporan dibuat', invalidate: refresh });

  if (list && !list.length) return <><PageHead title="Monitor" icon={IconPulse} /><Empty>Belum ada server.</Empty></>;
  return (
    <>
      <PageHead title="Monitor" icon={IconPulse}>
        {list && id && <select aria-label="Pilih server" value={id} onChange={(e) => navigate(`/monitor/${e.target.value}`)}>{list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        {view.data && <ServerStatusBadge status={view.data.server.last_status} />}
        <Button icon={IconRefresh} onClick={() => check.mutateAsync()}>Periksa sekarang</Button>
        <Button icon={IconBulb} title="Ringkasan kondisi server ditulis AI dari metrik dan peringatan terakhir" onClick={() => analyze.mutateAsync()}>Analisis AI</Button>
      </PageHead>
      {id && <Async query={view}>{(d) => <MonitorBody key={id} id={id} d={d} />}</Async>}
    </>
  );
}

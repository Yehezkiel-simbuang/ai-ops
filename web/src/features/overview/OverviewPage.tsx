// Ringkasan: vonis seluruh server di atas, lalu yang butuh tindakan Anda, peringatan, daftar server (terburuk dulu), dan rincian yang dilipat.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { q } from '@/api/queries';
import type { Overview } from '@/api/types';
import { RecStatusBadge, RunStatusBadge, ServerStatusBadge, LevelBadge } from '@/components/StatusBadges';
import { VerdictBanner } from '@/components/VerdictBanner';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Fold } from '@/components/ui/Fold';
import { Empty, Hint, Item, List, PageHead, Section, Tile, Tiles } from '@/components/ui/Layout';
import { IconBell, IconFlame, IconHome, IconLock, IconServer, IconTimer } from '@/components/icons';
import { ago, fmt, usd } from '@/lib/format';
import { ApprovalCard } from '@/features/setup/ApprovalCard';
import { fleet, sortAlerts, sortServers } from './summary';

const SHOWN_ALERTS = 8;

function FirstSteps({ o }: { o: Overview }) {
  const todo: Array<[string, string]> = [];
  if (!o.servers.length) todo.push(['Tambahkan server pertama Anda', '/server']);
  if (!o.setupReady) todo.push(['Atur penyedia dan model untuk peran Setup server', '/pengaturan']);
  if (!o.monitorReady) todo.push(['Atur model untuk peran Monitoring (opsional)', '/pengaturan']);
  if (!todo.length) return null;
  return <Hint><b>Langkah awal</b>{todo.map(([text, to]) => <div key={to + text}><Link to={to}>{text}</Link></div>)}</Hint>;
}

function MaintenanceHint({ o }: { o: Overview }) {
  const { overdue, soon } = o.maintenance;
  if (!overdue && !soon && !o.rotationDue) return null;
  return (
    <Hint icon={IconTimer}>
      <b>Pemeliharaan</b>
      <div>
        {overdue > 0 && `${overdue} tugas terlambat. `}{soon > 0 && `${soon} jatuh tempo dalam 7 hari. `}{o.rotationDue > 0 && `${o.rotationDue} password sudah waktunya diganti. `}
        <Link to="/inventaris">Buka Inventaris</Link>
      </div>
    </Hint>
  );
}

function OverviewBody({ o }: { o: Overview }) {
  const f = fleet(o), servers = sortServers(o.servers), alerts = sortAlerts(o.alerts), actionable = o.pending.length > 0 || o.incidents.length > 0 || o.maintenance.overdue > 0 || o.maintenance.soon > 0 || o.rotationDue > 0;
  return (
    <>
      <FirstSteps o={o} />
      <VerdictBanner label="Kondisi seluruh server" verdict={f.verdict} headline={f.headline} detail={f.detail} />

      <Section title="Perlu tindakan Anda" icon={IconLock}>
        {!actionable && <p className="lbl calm">Tidak ada yang menunggu Anda.</p>}
        {o.pending.length > 0 && (
          <>
            <h3>Menunggu persetujuan ({o.pending.length})</h3>
            <div className="tl">{o.pending.map((c) => <ApprovalCard key={c.id} command={c} runId={c.run_id} runName={c.run_name} />)}</div>
          </>
        )}
        {o.incidents.length > 0 && (
          <>
            <h3><IconFlame size={14} aria-hidden /> Insiden kritis dari agen ({o.incidents.length})</h3>
            <List>{o.incidents.map((i) => (
              <Item key={i.id} to={`/insiden/${i.id}`} title={i.title} sub={[`${i.server_name} | ${i.detail} | ${ago(i.opened)}`]}><RecStatusBadge status={i.rec_status} /></Item>
            ))}</List>
          </>
        )}
        <MaintenanceHint o={o} />
      </Section>

      {alerts.length > 0 && (
        <Section title={`Peringatan aktif (${alerts.length})`} icon={IconBell}>
          <List>{alerts.slice(0, SHOWN_ALERTS).map((a) => <Item key={a.id} title={a.title} sub={[`${a.server_name} | ${a.detail} | ${ago(a.ts)}`]}><LevelBadge level={a.level} /></Item>)}</List>
          {alerts.length > SHOWN_ALERTS && <p className="lbl">dan {alerts.length - SHOWN_ALERTS} lainnya. Buka Monitor tiap server untuk rinciannya.</p>}
        </Section>
      )}

      <Section title="Server" icon={IconServer}>
        {servers.length ? (
          <List>{servers.map((s) => (
            <Item key={s.id} to={`/monitor/${s.id}`} title={s.name} sub={[s.host + (s.monitor_on ? ` | dipantau, cek ${ago(s.last_seen)}` : ' | monitoring mati')]}>
              {s.open_alerts > 0 && <Badge tone="bad">{s.open_alerts} peringatan</Badge>}
              <ServerStatusBadge status={s.status} />
            </Item>
          ))}</List>
        ) : <Empty>Belum ada server.</Empty>}
      </Section>

      <Fold title="Setup terbaru" hint={o.runs.length ? `${o.runs.length} proses` : 'belum ada'}>
        {o.runs.length ? (
          <List>{o.runs.map((r) => {
            const done = r.steps.filter((s) => s.status === 'done').length;
            return <Item key={r.id} to={`/setup/${r.id}`} title={r.name} sub={[`${r.server_name ?? 'tanpa server'} | ${ago(r.updated)}${r.steps.length ? ` | langkah ${done}/${r.steps.length}` : ''}`]}><RunStatusBadge status={r.status} /></Item>;
          })}</List>
        ) : <Empty>Belum ada proses setup.</Empty>}
      </Fold>
      <Fold title="Pemakaian AI 7 hari" hint={`${fmt(o.usage.input + o.usage.output)} token`}>
        <Tiles>
          <Tile value={fmt(o.usage.input + o.usage.output)} label={`token (${usd(o.usage.cost, o.usage.costKnown || !o.usage.calls)})`} />
          <Tile value={fmt(o.servers.length)} label="server terdaftar" />
        </Tiles>
      </Fold>
    </>
  );
}

export function OverviewPage() {
  const query = useQuery(q.overview());
  return (
    <>
      <PageHead title="Ringkasan" icon={IconHome} />
      <Async query={query}>{(o) => <OverviewBody o={o} />}</Async>
    </>
  );
}

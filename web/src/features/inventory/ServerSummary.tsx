// Tampilan baca dokumentasi satu server: tentang, alamat, layanan, ketergantungan, fakta, runbook.
import { Link } from 'react-router-dom';
import type { ServerProfile } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Empty, Item, List, Section } from '@/components/ui/Layout';
import { IconBook, IconCpu, IconLayers, IconNetwork, IconSplit, IconTerminal } from '@/components/icons';
import { ago } from '@/lib/format';

const Row = ({ label, value }: { label: string; value?: string | null }) => <Item title={label} sub={[value || '-']} />;

export function ServerSummary({ p }: { p: ServerProfile }) {
  const s = p.server, f = s.facts ?? {};
  return (
    <div>
      <div className="cols">
        <div>
          <h2><IconBook size={16} aria-hidden />Tentang server ini</h2>
          <List>
            <Row label="Fungsi" value={s.purpose} /><Row label="Pemilik / penanggung jawab" value={s.owner} /><Row label="Lokasi" value={s.location} />
            <Row label="Tag" value={(s.tags ?? []).join(', ')} /><Row label="Akses SSH" value={`${s.username}@${s.host}:${s.port}`} /><Row label="OS" value={s.os_info || f.os} />
          </List>
        </div>
        <div>
          <h2><IconNetwork size={16} aria-hidden />Alamat</h2>
          {p.addresses.length
            ? <List>{p.addresses.map((a, i) => <Item key={i} title={a.label || a.kind} sub={[<><span className="mono">{a.address}</span>{a.notes ? ` | ${a.notes}` : ''}</>]}>{a.is_primary && <Badge tone="ok">utama</Badge>}</Item>)}</List>
            : <Empty>Belum ada alamat. Ubah dokumentasi atau "Isi otomatis dari server".</Empty>}
        </div>
      </div>
      <div className="cols sec">
        <div>
          <h2><IconLayers size={16} aria-hidden />Layanan</h2>
          {p.services.length
            ? <List>{p.services.map((v, i) => <Item key={i} title={v.name} sub={[`${v.port ? `${v.port}/${v.protocol}` : ''}${v.url ? ` | ${v.url}` : ''}${v.notes ? ` | ${v.notes}` : ''}`]} />)}</List>
            : <Empty>Belum ada layanan terdokumentasi.</Empty>}
        </div>
        <div>
          <h2><IconSplit size={16} aria-hidden />Ketergantungan</h2>
          {p.depends.length || p.dependents.length ? (
            <List>
              {p.depends.map((d) => <Item key={`d${d.id}`} title="Bergantung pada" sub={[<><Link to={`/inventaris/${d.id}`}>{d.name}</Link>{d.note ? ` | ${d.note}` : ''}</>]} />)}
              {p.dependents.map((d) => <Item key={`u${d.id}`} title="Dipakai oleh" sub={[<><Link to={`/inventaris/${d.id}`}>{d.name}</Link>{d.note ? ` | ${d.note}` : ''}</>]} />)}
            </List>
          ) : <Empty>Tidak ada. Dampak gangguan terlihat di sini.</Empty>}
        </div>
      </div>
      {f.cpu_cores ? (
        <Section title={`Fakta dari server (${s.facts_at ? ago(s.facts_at) : ''})`} icon={IconCpu}>
          <List>
            <Row label="Perangkat keras" value={`${f.cpu_cores} core${f.cpu_model ? ` (${f.cpu_model})` : ''}, RAM ${f.ram_mb} MB, disk / ${f.disk_root || '-'}`} />
            <Row label="Kernel / uptime" value={`${f.kernel || '-'} | ${f.uptime_d != null ? `${f.uptime_d} hari` : '-'}`} />
            <Row label="Pembaruan tertunda" value={`${f.updates != null ? `${f.updates} paket` : '-'}${f.reboot_required ? ' | PERLU REBOOT' : ''}`} />
            <Row label="Port mendengarkan" value={(f.ports ?? []).join(', ')} /><Row label="Perangkat lunak terdeteksi" value={(f.tools ?? []).join(', ')} />
          </List>
        </Section>
      ) : null}
      {s.runbook && <Section title="Catatan / Runbook" icon={IconTerminal}><pre className="out free">{s.runbook}</pre></Section>}
    </div>
  );
}

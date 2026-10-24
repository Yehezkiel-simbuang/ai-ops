// Server mana yang perlu dipelihara (patch, reboot, OS habis dukungan), dari fakta yang dilaporkan agen. Yang paling parah di atas.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { q } from '@/api/queries';
import type { PatchRow } from '@/api/types';
import { LevelBadge } from '@/components/StatusBadges';
import { Badge } from '@/components/ui/Badge';
import { DataGrid, type Column } from '@/components/ui/DataGrid';
import { Fold } from '@/components/ui/Fold';
import { RANK } from '@/lib/levels';
import { ago } from '@/lib/format';

const eolText = (d: number | null): string => (d == null ? 'tidak dinilai' : d < 0 ? `berakhir ${-d} hari lalu` : `${d} hari lagi`);

const columns: Array<Column<PatchRow>> = [
  { id: 'level', header: 'Perhatian', sort: (r) => (r.level ? RANK[r.level] : 0), cell: (r) => (r.level ? <LevelBadge level={r.level} /> : <Badge tone="ok">aman</Badge>) },
  { id: 'server', header: 'Server', sort: (r) => r.name, cell: (r) => <><strong>{r.name}</strong><div className="lbl">{r.os || 'OS tidak terbaca'}{r.stale && ` | laporan lama (${ago(r.reported)})`}</div></> },
  { id: 'why', header: 'Yang perlu dikerjakan', cell: (r) => (r.reasons.length ? <>{r.reasons.map((x) => <div key={x.text}>{x.text}</div>)}</> : <span className="lbl">Tidak ada.</span>) },
  { id: 'sec', header: 'Keamanan', sort: (r) => r.security ?? -1, cell: (r) => (r.security == null ? '-' : r.security) },
  { id: 'upd', header: 'Pembaruan', sort: (r) => r.updates ?? -1, cell: (r) => (r.updates == null ? '-' : r.updates) },
  { id: 'reboot', header: 'Reboot', sort: (r) => (r.reboot ? r.reboot_days ?? 0 : -1), cell: (r) => (r.reboot ? `menunggu${r.reboot_days != null ? ` ${r.reboot_days} hari` : ''}` : 'tidak') },
  { id: 'eol', header: 'Dukungan OS', sort: (r) => r.eol_days ?? Number.MAX_SAFE_INTEGER, cell: (r) => eolText(r.eol_days) }
];

export function PatchingPanel() {
  const query = useQuery(q.patching());
  if (!query.data) return null;   // belum ada data atau gagal dimuat: bagian ini tambahan, jangan menghalangi jadwal di bawahnya
  const { rows, without_agent } = query.data, urgent = rows.filter((r) => r.level && RANK[r.level] >= RANK.major).length, any = rows.filter((r) => r.level).length;
  const hint = rows.length ? (any ? `${any} perlu perhatian${urgent ? `, ${urgent} mendesak` : ''}` : 'semua aman') : 'belum ada agen yang melapor';
  return (
    <Fold title="Pembaruan sistem" hint={hint} open={urgent > 0}>
      {rows.length
        ? <DataGrid label="Pembaruan sistem per server" rows={rows} columns={columns} rowKey={(r) => r.server_id} defaultSort={{ id: 'level', dir: 'desc' }} storageKey="aiops.patching.size" empty="" />
        : <p className="lbl">Fakta pembaruan datang dari agen. Pasang agen di server (menu Server, ikon Agen) dan datanya muncul dalam beberapa menit.</p>}
      <p className="lbl" style={{ marginTop: 8 }}>
        {without_agent > 0 && `${without_agent} server belum punya agen yang melapor, jadi tidak ikut dinilai. `}
        Batas tiap tingkat diatur di <Link to="/standar">Standar</Link>; daftar masa dukungan OS hanya mencakup distro umum. Agen hanya membaca, tidak memasang apa pun.
      </p>
    </Fold>
  );
}

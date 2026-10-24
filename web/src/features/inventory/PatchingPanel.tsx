// Server mana yang perlu dipelihara (patch, reboot, OS habis dukungan), dari fakta yang dilaporkan agen. Yang paling parah di atas.
// Klik satu baris untuk melihat paket yang akan naik dan kerentanan (CVE) yang ditutup patch itu.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { q } from '@/api/queries';
import type { PatchRow } from '@/api/types';
import { LevelBadge } from '@/components/StatusBadges';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type Column } from '@/components/ui/DataGrid';
import { Fold } from '@/components/ui/Fold';
import { Modal } from '@/components/ui/Modal';
import { RANK } from '@/lib/levels';
import { ago } from '@/lib/format';

const eolText = (d: number | null): string => (d == null ? 'tidak dinilai' : d < 0 ? `berakhir ${-d} hari lalu` : `${d} hari lagi`);

const vulnCell = (r: PatchRow) => {
  if (r.cves == null) return <span className="lbl">-</span>;
  return <>{r.cves} CVE{r.exploited > 0 && <> <Badge tone="bad">{r.exploited} dieksploitasi</Badge></>}{r.vuln_unknown > 0 && <div className="lbl">{r.vuln_unknown} paket belum bisa dicek</div>}</>;
};

const columns: Array<Column<PatchRow>> = [
  { id: 'level', header: 'Perhatian', sort: (r) => (r.level ? RANK[r.level] : 0), cell: (r) => (r.level ? <LevelBadge level={r.level} /> : <Badge tone="ok">aman</Badge>) },
  { id: 'server', header: 'Server', sort: (r) => r.name, cell: (r) => <><strong>{r.name}</strong><div className="lbl">{r.os || 'OS tidak terbaca'}{r.stale && ` | laporan lama (${ago(r.reported)})`}</div></> },
  { id: 'why', header: 'Yang perlu dikerjakan', cell: (r) => (r.reasons.length ? <>{r.reasons.map((x) => <div key={x.text}>{x.text}</div>)}</> : <span className="lbl">Tidak ada.</span>) },
  { id: 'sec', header: 'Keamanan', sort: (r) => r.security ?? -1, cell: (r) => (r.security == null ? '-' : r.security) },
  { id: 'upd', header: 'Pembaruan', sort: (r) => r.updates ?? -1, cell: (r) => (r.updates == null ? '-' : r.updates) },
  { id: 'cve', header: 'Kerentanan', sort: (r) => (r.exploited || 0) * 10000 + (r.cves ?? -1), cell: vulnCell },
  { id: 'reboot', header: 'Reboot', sort: (r) => (r.reboot ? r.reboot_days ?? 0 : -1), cell: (r) => (r.reboot ? `menunggu${r.reboot_days != null ? ` ${r.reboot_days} hari` : ''}` : 'tidak') },
  { id: 'eol', header: 'Dukungan OS', sort: (r) => r.eol_days ?? Number.MAX_SAFE_INTEGER, cell: (r) => eolText(r.eol_days) }
];

function PatchDetailBody({ id, onClose }: { id: number; onClose: () => void }) {
  const query = useQuery(q.patchDetail(id));
  return (
    <Async query={query}>{(d) => (
      <div>
        <h2>Pembaruan {d.name}</h2>
        <p className="lbl">{d.os || 'OS tidak terbaca'} | {d.total} paket akan naik{d.matched_at ? ` | kerentanan dicocokkan ${ago(d.matched_at)}` : ''}</p>
        {!d.supported && <p className="lbl">Pencocokan kerentanan belum mendukung OS ini (baru Debian dan Ubuntu), jadi hanya daftar paket yang ditampilkan.</p>}
        {d.supported && !d.matched_at && <p className="lbl">Kerentanan sedang dicocokkan; buka lagi beberapa saat lagi.</p>}
        {d.total === 0 ? <p className="lbl">Tidak ada paket yang menunggu.</p> : (
          <div className="tbl-wrap"><table className="tbl cards" aria-label="Paket yang akan naik">
            <thead><tr><th>Paket</th><th>Versi</th><th>Kerentanan yang ditutup</th></tr></thead>
            <tbody>{d.packages.map((p) => (
              <tr key={p.name}>
                <td data-label="Paket"><strong>{p.name}</strong>{p.sec && <> <Badge tone="warn">keamanan</Badge></>}{p.source && p.source !== p.name && <div className="lbl">sumber: {p.source}</div>}</td>
                <td data-label="Versi"><span className="lbl">{p.old} ke {p.new}</span></td>
                <td data-label="Kerentanan yang ditutup">{p.unknown ? <span className="lbl">belum bisa dicek (sumber tidak terjangkau)</span> : p.cves.length || p.ids.length
                  ? <>{p.cves.slice(0, 8).map((c) => <span key={c} style={{ marginRight: 6 }}><a href={`https://nvd.nist.gov/vuln/detail/${c}`} target="_blank" rel="noreferrer noopener">{c}</a>{p.exploited.includes(c) && <> <Badge tone="bad">dieksploitasi</Badge></>}</span>)}{p.cves.length > 8 && <span className="lbl">dan {p.cves.length - 8} lagi</span>}{!p.cves.length && <span className="lbl">{p.ids.join(', ')}</span>}</>
                  : <span className="lbl">{d.supported && d.matched_at ? 'tidak ada yang tercatat' : '-'}</span>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        <p className="lbl" style={{ marginTop: 8 }}>Sumber: OSV.dev (kerentanan yang menimpa versi terpasang tetapi tidak versi baru) dan CISA KEV (sedang dieksploitasi). Ini daftar pembaruan, bukan jaminan bahwa tidak ada kerentanan lain.</p>
        <div className="row" style={{ marginTop: 12 }}><Button onClick={onClose}>Tutup</Button></div>
      </div>
    )}</Async>
  );
}

export function PatchingPanel() {
  const query = useQuery(q.patching()), [open, setOpen] = useState<number | null>(null);
  if (!query.data) return null;   // belum ada data atau gagal dimuat: bagian ini tambahan, jangan menghalangi jadwal di bawahnya
  const { rows, without_agent } = query.data, urgent = rows.filter((r) => r.level && RANK[r.level] >= RANK.major).length, any = rows.filter((r) => r.level).length;
  const hint = rows.length ? (any ? `${any} perlu perhatian${urgent ? `, ${urgent} mendesak` : ''}` : 'semua aman') : 'belum ada agen yang melapor';
  return (
    <Fold title="Pembaruan sistem" hint={hint} open={urgent > 0}>
      {rows.length
        ? <DataGrid label="Pembaruan sistem per server" rows={rows} columns={columns} rowKey={(r) => r.server_id} onRowClick={(r) => setOpen(r.server_id)} defaultSort={{ id: 'level', dir: 'desc' }} storageKey="aiops.patching.size" empty="" />
        : <p className="lbl">Fakta pembaruan datang dari agen. Pasang agen di server (menu Server, ikon Agen) dan datanya muncul dalam beberapa menit.</p>}
      <p className="lbl" style={{ marginTop: 8 }}>
        {without_agent > 0 && `${without_agent} server belum punya agen yang melapor, jadi tidak ikut dinilai. `}
        Klik satu baris untuk melihat paket dan CVE-nya. Batas tiap tingkat diatur di <Link to="/standar">Standar</Link>; daftar masa dukungan OS hanya mencakup distro umum. Agen hanya membaca, tidak memasang apa pun.
      </p>
      <Modal open={open !== null} onClose={() => setOpen(null)}>{open !== null && <PatchDetailBody id={open} onClose={() => setOpen(null)} />}</Modal>
    </Fold>
  );
}

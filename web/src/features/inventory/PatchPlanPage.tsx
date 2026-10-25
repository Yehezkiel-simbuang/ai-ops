// Rencana patch satu server: ringkasan dampak (paket, CVE, layanan yang kemungkinan perlu restart), lalu langkah yang harus disetujui.
// Tidak ada yang dijalankan sebelum Anda menyetujui; restart layanan dan reboot dikerjakan terpisah.
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { q } from '@/api/queries';
import type { PatchPlan } from '@/api/types';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Fold } from '@/components/ui/Fold';
import { PageHead, Section } from '@/components/ui/Layout';
import { IconLayers } from '@/components/icons';
import { RecommendationView } from '@/features/incidents/RecommendationView';

const STATE_TEXT: Record<string, string> = {
  proposed: 'Draf: rencana sudah disusun tetapi belum Anda setujui, jadi belum ada yang dijalankan di server.',
  approved: 'Berjalan: sudah disetujui dan sedang dimulai. Anda boleh pindah halaman; kemajuannya tersimpan di sini.',
  executing: 'Berjalan: langkahnya sedang dikerjakan di server. Anda boleh pindah halaman; kemajuannya tersimpan di sini.',
  done: 'Selesai: semua langkah yang disetujui sudah dijalankan. Daftar di panel Pembaruan sistem diperbarui setelah agen melapor ulang.',
  failed: 'Gagal: rencana berhenti di langkah yang gagal, dan langkah sesudahnya tidak dijalankan. Lihat keluaran langkah itu di bawah.',
  rejected: 'Ditolak: rencana ini tidak dijalankan.',
  superseded: 'Digantikan: ada rencana yang lebih baru untuk server ini, jadi yang ini tidak akan dijalankan.'
};

function Impact({ p }: { p: PatchPlan }) {
  const m = p.meta, t = m.totals;
  return (
    <Section title="Dampak yang diperkirakan">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Badge>{t.packages} paket</Badge>
        {t.security > 0 && <Badge tone="warn">{t.security} keamanan</Badge>}
        {t.cves > 0 && <Badge>{t.cves} CVE ditutup</Badge>}
        {t.exploited > 0 && <Badge tone="bad">{t.exploited} sedang dieksploitasi</Badge>}
        {t.thirdParty > 0 && <Badge tone="mute">{t.thirdParty} dari repositori pihak ketiga</Badge>}
        {m.restarts.length > 0 && <Badge tone="warn">kemungkinan restart: {m.restarts.join(', ')}</Badge>}
        {m.reboot && <Badge tone="warn">kemungkinan perlu reboot</Badge>}
      </div>
      <p className="lbl" style={{ marginTop: 8 }}>Perkiraan dari nama paket dan data kerentanan, bukan jaminan. Simpan snapshot atau cadangan sebelum patch besar. Restart layanan dan reboot tidak ikut dalam rencana ini.</p>
      <Fold title="Paket yang akan diperbarui" hint={`${m.packages.length} paket`} open={m.packages.length <= 8}>
        <div className="tbl-wrap"><table className="tbl cards" aria-label="Paket dalam rencana">
          <thead><tr><th>Paket</th><th>Versi</th><th>Kerentanan yang ditutup</th><th>Dampak</th></tr></thead>
          <tbody>{m.packages.map((x) => (
            <tr key={x.name}>
              <td data-label="Paket"><strong>{x.name}</strong>{x.sec && <> <Badge tone="warn">keamanan</Badge></>}{!x.official && <div className="lbl">repositori pihak ketiga</div>}</td>
              <td data-label="Versi"><span className="lbl">{x.old} ke {x.new}</span></td>
              <td data-label="Kerentanan yang ditutup">{x.cves.length ? x.cves.slice(0, 6).map((c) => <span key={c} style={{ marginRight: 6 }}><a href={`https://nvd.nist.gov/vuln/detail/${c}`} target="_blank" rel="noreferrer noopener">{c}</a>{x.exploited.includes(c) && <> <Badge tone="bad">dieksploitasi</Badge></>}</span>) : <span className="lbl">{x.official ? 'tidak ada yang tercatat' : 'belum bisa dicek'}</span>}</td>
              <td data-label="Dampak"><span className="lbl">{x.impact ?? '-'}</span></td>
            </tr>))}</tbody>
        </table></div>
      </Fold>
    </Section>
  );
}

export function PatchPlanPage() {
  const id = Number(useParams().id), query = useQuery(q.patchPlan(id));
  return (
    <>
      <PageHead title={query.data?.title ?? 'Rencana patch'} icon={IconLayers}>
        <Badge tone="acc" to="/inventaris">Kembali ke Inventaris</Badge>
      </PageHead>
      <Async query={query}>{(p) => (
        <>
          <p className="lbl" role="status" style={{ margin: '0 0 8px' }}>{STATE_TEXT[p.status] ?? ''}</p>
          <Impact p={p} />
          <Section title="Langkah dan persetujuan">
            <RecommendationView key={p.id} incident={{ id: null, server_name: p.server_name }} rec={p} path={p.path} />
          </Section>
        </>
      )}</Async>
    </>
  );
}

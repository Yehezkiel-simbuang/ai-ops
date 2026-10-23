// Daftar kredensial (dipakai di Vault global dan di halaman server): ungkap, rotasi, riwayat versi, ubah, hapus.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAction } from '@/api/queries';
import type { Credential, CredentialVersion, Revealed } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Empty, Item, List } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconEye, IconHistory, IconRefresh, IconTrash, IconWrench } from '@/components/icons';
import { del, get, post } from '@/lib/api';
import { ago, dateStr } from '@/lib/format';
import { CredentialDialog } from './CredentialDialog';

const REVEAL_NOTE = 'Tindakan ini dicatat di jejak audit.';

function VersionsDialog({ credential, onClose }: { credential: Credential; onClose: () => void }) {
  const { askPassword, showSecret } = useDialogs();
  const versions = useQuery({ queryKey: ['credentials', credential.id, 'versions'], queryFn: () => get<CredentialVersion[]>(`/api/credentials/${credential.id}/versions`) });
  const view = async (v: CredentialVersion) => {
    const password = await askPassword('Konfirmasi untuk melihat versi lama.');
    if (!password) return;
    const r = await post<Revealed>(`/api/credential-versions/${v.id}/reveal`, { password });
    showSecret(`Versi ${dateStr(r.changed_at)}`, `Password lama dari ${credential.label}`, r.secret);
  };
  return (
    <>
      <h2><IconHistory size={16} aria-hidden />Riwayat password: {credential.label}</h2>
      {versions.data?.length
        ? <List>{versions.data.map((v, i) => <Item key={v.id} title={`${i === 0 ? 'Saat ini | ' : ''}${dateStr(v.changed_at)}`} sub={[`diubah oleh ${v.changed_by ?? '-'}`]}><Button icon={IconEye} onClick={() => view(v)}>Lihat</Button></Item>)}</List>
        : <Empty>{versions.isPending ? 'Memuat...' : 'Belum ada.'}</Empty>}
      <div className="row" style={{ marginTop: 12 }}><Button onClick={onClose}>Tutup</Button></div>
    </>
  );
}

/** Tombol aksi satu kredensial beserta dialognya; dipakai di daftar (halaman server) dan di tabel Vault. */
export function CredentialActions({ c }: { c: Credential }) {
  const { confirm, askPassword, showSecret } = useDialogs();
  const [editing, setEditing] = useState(false), [showVersions, setShowVersions] = useState(false);
  const invalidate = [['vault'], ['servers', c.server_id ?? 0, 'credentials'], ['inventory'], ['overview']];

  const reveal = useAction(async () => {
    const password = await askPassword(`Masukkan password akun AI Ops untuk melihat "${c.label}". ${REVEAL_NOTE}`);
    if (!password) return null;
    return post<Revealed>(`/api/credentials/${c.id}/reveal`, { password });
  }, { invalidate, onSuccess: (r) => { if (r) showSecret(c.label, r.username ? `Pengguna: ${r.username}` : undefined, r.secret); } });
  const rotate = useAction(async () => {
    if (!(await confirm(`Buat password baru untuk "${c.label}"? Password lama disimpan di riwayat. Anda tetap harus MENERAPKANNYA di server/layanannya.`, 'Buat password baru'))) return null;
    return post<Revealed>(`/api/credentials/${c.id}/rotate`, { length: 28 });
  }, { invalidate, onSuccess: (r) => { if (r) showSecret(`Password baru: ${c.label}`, 'Terapkan password ini di server/layanan, lalu tutup. Aplikasi tidak mengubah password di server untuk Anda.', r.secret); } });
  const remove = useAction(async () => { if (await confirm(`Hapus kredensial "${c.label}" beserta riwayatnya?`, 'Hapus')) await del(`/api/credentials/${c.id}`); }, { invalidate });

  return (
    <>
      {c.has_secret && <Button icon={IconEye} title="Lihat password (butuh konfirmasi)" onClick={() => reveal.mutateAsync()}>Ungkap</Button>}
      <Button icon={IconRefresh} title="Buat password baru" onClick={() => rotate.mutateAsync()}>Rotasi</Button>
      {c.versions > 1 && <Button icon={IconHistory} onClick={() => setShowVersions(true)}>Riwayat</Button>}
      <Button icon={IconWrench} aria-label={`Ubah ${c.label}`} onClick={() => setEditing(true)} />
      <Button icon={IconTrash} aria-label={`Hapus ${c.label}`} onClick={() => remove.mutateAsync()} />
      <CredentialDialog open={editing} onClose={() => setEditing(false)} serverId={c.server_id} credential={c} />
      <Modal open={showVersions} onClose={() => setShowVersions(false)}><VersionsDialog credential={c} onClose={() => setShowVersions(false)} /></Modal>
    </>
  );
}

export const credentialBadges = (c: Credential) => (
  <>
    {c.rotation_overdue ? <Badge tone="bad">ganti password (terlambat)</Badge> : c.rotation_due_at ? <Badge>ganti {dateStr(c.rotation_due_at)}</Badge> : null}
    {c.expired ? <Badge tone="bad">kedaluwarsa</Badge> : c.expires_at ? <Badge tone="warn">berlaku s.d. {dateStr(c.expires_at)}</Badge> : null}
  </>
);

function CredentialRow({ c, withServer }: { c: Credential; withServer: boolean }) {
  const title = `${withServer && c.server_name ? `${c.server_name} | ` : ''}${c.label}`;
  return (
    <Item top title={title} sub={[
      <><Badge>{c.kind}</Badge>{' '}{c.username ? <span className="mono">{c.username}</span> : <span className="lbl">tanpa pengguna</span>}{c.url ? ` | ${c.url}` : ''}{c.port ? `:${c.port}` : ''}</>,
      c.notes,
      `diganti ${dateStr(c.rotated_at)} (${c.age_days} hari lalu)${c.last_revealed ? ` | terakhir dilihat ${ago(c.last_revealed)}` : ''}`
    ]}>
      {credentialBadges(c)}
      <CredentialActions c={c} />
    </Item>
  );
}

export function CredentialList({ credentials, withServer = false, empty }: { credentials: Credential[]; withServer?: boolean; empty: string }) {
  if (!credentials.length) return <Empty>{empty}</Empty>;
  return <List>{credentials.map((c) => <CredentialRow key={c.id} c={c} withServer={withServer} />)}</List>;
}

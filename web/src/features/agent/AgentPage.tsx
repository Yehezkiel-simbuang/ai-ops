// Agen kecil di server: status, kunci HMAC, panduan pemasangan (rahasia hanya tampil sekali).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { q, useAction } from '@/api/queries';
import type { AgentGuide, AgentStatus, ExecPath } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Empty, Hint, Item, List, PageHead } from '@/components/ui/Layout';
import { IconAlert, IconBook, IconCopy, IconKey, IconPulse, IconShield, IconTerminal, IconTrash } from '@/components/icons';
import { del, post } from '@/lib/api';
import { ago } from '@/lib/format';
import { copyText } from '@/lib/clipboard';
import { toast } from '@/lib/toast';
import { EXEC_PATHS } from '@/features/incidents/RecommendationView';

function StatusList({ a, path }: { a: AgentStatus; path: ExecPath }) {
  return (
    <List>
      <Item title={a.online ? 'Online' : 'Offline'} sub={[`terakhir terlihat ${ago(a.last_seen)}${a.version ? ` | versi ${a.version}` : ''}${a.hostname ? ` | ${a.hostname}` : ''}`]}>
        <Badge tone={a.online ? 'ok' : 'bad'}>{a.online ? 'online' : 'offline'}</Badge>
      </Item>
      <Item title="Eksekusi perbaikan lewat agen" sub={[a.exec_enabled ? 'Diizinkan di konfigurasi agen (allow_exec=true)' : 'Dimatikan di agen: agen hanya melapor, tidak menjalankan apa pun']}>
        <Badge tone={a.exec_enabled ? 'warn' : 'mute'}>{a.exec_enabled ? 'aktif' : 'mati'}</Badge>
      </Item>
      <Item title="Jalur eksekusi yang dipakai" sub={[EXEC_PATHS[path]]} />
      <Item title="Kondisi kritis terbuka di agen" sub={[a.open_keys?.length ? a.open_keys.join(', ') : 'tidak ada']} />
    </List>
  );
}

function InstallGuide({ guide }: { guide: AgentGuide }) {
  const copy = async () => { if (await copyText(guide.script)) toast('Tersalin'); else toast('Gagal menyalin; pilih teks lalu salin manual', true); };
  return (
    <section className="sec">
      <h2><IconTerminal size={16} aria-hidden />Panduan pemasangan (jalankan sebagai root di server)</h2>
      {(guide.warnings ?? []).map((w) => <Hint key={w} icon={IconAlert}>{w}</Hint>)}
      <Hint icon={IconAlert}>Secret hanya tampil sekali, di panduan ini. Simpan hanya di server. Setelah halaman ini ditutup, Anda perlu rotasi kunci untuk mendapatkannya lagi.</Hint>
      <textarea className="mono" readOnly value={guide.script} aria-label="Skrip pemasangan" style={{ minHeight: 340, width: '100%', fontSize: '.76rem' }} onFocus={(e) => e.currentTarget.select()} />
      <div className="row" style={{ marginTop: 8 }}><Button icon={IconCopy} onClick={copy}>Salin</Button></div>
    </section>
  );
}

export function AgentPage() {
  const id = Number(useParams().id), { confirm } = useDialogs();
  const servers = useQuery(q.servers()), overview = useQuery(q.agent(id));
  const server = servers.data?.find((s) => s.id === id);
  const [exec, setExec] = useState(false), [guide, setGuide] = useState<AgentGuide | null>(null);
  const invalidate = [['servers', id, 'agent'], ['servers']];
  const issue = useAction(() => post<AgentGuide>(`/api/servers/${id}/agent`, { exec }), { invalidate, onSuccess: setGuide });
  const remove = useAction(() => del(`/api/servers/${id}/agent`), { invalidate, onSuccess: () => setGuide(null) });

  if (servers.data && !server) return <><PageHead title="Agen" icon={IconShield} /><Empty>Pilih server dari halaman Server.</Empty></>;
  return (
    <>
      <PageHead title={`Agen: ${server?.name ?? ''}`} icon={IconShield}><Badge tone="acc" to="/server">Server</Badge></PageHead>
      <Hint icon={IconBook}><span>Pertama kali? Agen butuh alamat <b>HTTPS</b> aplikasi yang bisa dibuka dari server Anda. Langkah lengkap dan cara memeriksa bila agen tidak online ada di <Link to="/panduan?bagian=agen">panduan pemasangan agen</Link>.</span></Hint>
      <Async query={overview}>{(d) => {
        const a = d.agent;
        const create = async () => {
          if (a && !(await confirm('Kunci lama akan berhenti berlaku. Agen yang sudah terpasang harus diperbarui dengan konfigurasi baru. Lanjutkan?', 'Rotasi kunci'))) return;
          await issue.mutateAsync();
        };
        const removeAgent = async () => { if (await confirm('Hapus kredensial agen? Agen di server akan ditolak.', 'Hapus')) await remove.mutateAsync(); };
        return (
          <>
            <div className="cols">
              <div><h2><IconPulse size={16} aria-hidden />Status</h2>{a ? <StatusList a={a} path={d.path} /> : <Empty>Agen belum dipasang untuk server ini.</Empty>}</div>
              <div>
                <h2><IconKey size={16} aria-hidden />{a ? 'Kunci agen' : 'Pasang agen'}</h2>
                <label className="checkline" style={{ marginBottom: 10 }}><input type="checkbox" checked={exec} onChange={(e) => setExec(e.target.checked)} /><span>Izinkan agen menjalankan perbaikan yang saya setujui (allow_exec). Kosongkan bila agen hanya boleh melapor.</span></label>
                <div className="row">
                  <Button primary icon={IconKey} onClick={create}>{a ? 'Rotasi kunci dan cetak ulang panduan' : 'Buat kunci agen'}</Button>
                  {a && <Button icon={IconTrash} onClick={removeAgent}>Hapus agen</Button>}
                </div>
                <p className="lbl" style={{ marginTop: 10 }}>Yang dikirim agen: hanya perubahan status KRITIS (mulai dan pulih, dengan diagnostik singkat yang disamarkan saat mulai) dan detak jantung sekitar 70 byte tiap menit. Kondisi normal tidak mengirim apa pun. Agen hanya membuat koneksi keluar ke aplikasi; tidak membuka port.</p>
              </div>
            </div>
            {guide && <InstallGuide guide={guide} />}
          </>
        );
      }}</Async>
    </>
  );
}

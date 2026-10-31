// Playground: pasang susunan Docker Compose di server uji (khusus uji), periksa kesehatannya, uji beban, lalu copot.
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { q, useAction } from '@/api/queries';

import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Async } from '@/components/ui/Async';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Hint, Item, List, Note, PageHead } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconClose, IconCloud, IconGauge, IconInfo, IconList, IconPlay, IconPlus, IconTrash, IconWrench } from '@/components/icons';
import { del, get, post } from '@/lib/api';
import type { PlaygroundDeploy, PlaygroundStatus } from './types';

const BUSY: PlaygroundStatus[] = ['deploying', 'stopping'];
export const playgroundQ = {
  list: () => queryOptions({
    queryKey: ['playground', 'list'], queryFn: () => get<PlaygroundDeploy[]>('/api/playground'),
    refetchInterval: (query) => (query.state.data?.some((d) => BUSY.includes(d.status)) ? 3000 : 15_000)   // lebih sering selama ada yang diproses
  })
};

export const STATUS: Record<PlaygroundStatus, [Tone, string]> = {
  draft: ['mute', 'Draf'], deploying: ['acc', 'Memasang'], running: ['ok', 'Berjalan'], failed: ['bad', 'Gagal'], stopping: ['acc', 'Mencopot'], stopped: ['mute', 'Dicopot']
};

/** Ringkasan yang ditampilkan sebelum pemasangan disetujui: apa yang akan ditarik, dibuka, dan disimpan di server. */
export function deploySummary(d: Pick<PlaygroundDeploy, 'name' | 'server_name' | 'server_host' | 'analysis'>): string[] {
  const a = d.analysis;
  return [
    `Pasang "${d.name}" di server playground ${d.server_name} (${d.server_host}).`,
    `Image yang akan ditarik: ${a.services.map((s) => s.image).join(', ')}.`,
    a.publish.length ? `Port yang dibuka di server: ${a.publish.map((p) => `${p.host} (${p.service})`).join(', ')}.` : 'Tidak ada port yang dibuka ke luar.',
    ...a.warnings.map((w) => `Perhatian: ${w}`),
    'Data di dalam volume dihapus saat susunan dicopot. Gunakan hanya data uji, jangan data produksi.'
  ];
}

function LogsDialog({ d, onClose }: { d: PlaygroundDeploy; onClose: () => void }) {
  const live = useQuery({ queryKey: ['playground', 'logs', d.id], queryFn: () => get<{ text: string }>(`/api/playground/${d.id}/logs`), enabled: d.status === 'running', refetchInterval: 5000 });
  const text = d.status === 'running' ? (live.data?.text ?? 'Memuat...') : (d.log || 'Belum ada log.');
  return (
    <div className="form">
      <h2><IconList size={16} aria-hidden />Log: {d.name}</h2>
      <p className="lbl">{d.status === 'running' ? 'Log kontainer (200 baris terakhir, diperbarui tiap 5 detik).' : 'Keluaran pemasangan terakhir.'}</p>
      <pre className="out" tabIndex={0} style={{ maxHeight: 420, overflow: 'auto', fontSize: '.75rem', whiteSpace: 'pre-wrap' }}>{text}</pre>
      <div className="row"><Button icon={IconClose} onClick={onClose}>Tutup</Button></div>
    </div>
  );
}

function Row({ d, onLogs }: { d: PlaygroundDeploy; onLogs: (d: PlaygroundDeploy) => void }) {
  const { confirm } = useDialogs(), navigate = useNavigate(), invalidate = [['playground']];
  const deploy = useAction(() => post(`/api/playground/${d.id}/deploy`), { invalidate });
  const stop = useAction(() => post(`/api/playground/${d.id}/stop`), { invalidate });
  const remove = useAction(() => del(`/api/playground/${d.id}`), { invalidate });
  const [tone, label] = STATUS[d.status], busy = BUSY.includes(d.status);
  const install = async () => {
    const ok = await confirm(<div>{deploySummary(d).map((l) => <p key={l}>{l}</p>)}</div>, d.status === 'running' ? 'Pasang ulang' : 'Pasang');
    if (ok) await deploy.mutateAsync();
  };
  return (
    <Item title={d.name} sub={[`${d.server_name} (${d.server_host}) | ${d.analysis.services.length} layanan`, d.detail || 'Belum dipasang', d.target ? `Target uji: ${d.target}` : '']}>
      <Badge tone={tone}>{label}</Badge>
      {!busy && d.status !== 'running' && <Button primary icon={IconPlay} onClick={install}>{d.status === 'failed' ? 'Pasang ulang' : 'Pasang'}</Button>}
      {d.status === 'running' && <Button primary icon={IconGauge} onClick={() => navigate(`/uji-beban?target=${encodeURIComponent(d.target)}&nama=${encodeURIComponent(d.name)}&pg=${d.id}`)} disabled={!d.target}>Uji beban</Button>}
      {d.status === 'running' && <Button onClick={install}>Pasang ulang</Button>}
      {d.status !== 'draft' && <Button icon={IconList} onClick={() => onLogs(d)}>Log</Button>}
      {['running', 'failed'].includes(d.status) && <Button icon={IconTrash} onClick={async () => { if (await confirm(`Copot "${d.name}" dari ${d.server_name}? Kontainer, jaringan, dan volume (data uji) dihapus.`, 'Copot')) await stop.mutateAsync(); }}>Copot</Button>}
      {!busy && d.status !== 'running' && <Button icon={IconWrench} aria-label={`Ubah ${d.name}`} onClick={() => navigate(`/playground/${d.id}`)} disabled={d.status === 'failed'} title={d.status === 'failed' ? 'Copot dulu sebelum mengubah' : undefined} />}
      {['draft', 'stopped'].includes(d.status) && <Button icon={IconTrash} aria-label={`Hapus ${d.name}`} onClick={async () => { if (await confirm(`Hapus susunan "${d.name}"?`, 'Hapus')) await remove.mutateAsync(); }} />}
    </Item>
  );
}

export function PlaygroundPage() {
  const list = useQuery(playgroundQ.list()), servers = useQuery(q.servers());
  const navigate = useNavigate(), [logs, setLogs] = useState<number | null>(null);
  const playgrounds = (servers.data ?? []).filter((s) => s.playground);
  const current = logs === null ? null : (list.data ?? []).find((d) => d.id === logs) ?? null;
  // Status "Berjalan" tersimpan di basis data; cocokkan dengan keadaan nyata di server sekali saat halaman dibuka (baca-saja).
  const qc = useQueryClient(), [checked, setChecked] = useState(false);
  useEffect(() => {
    if (checked || !list.data) return; setChecked(true);
    const running = list.data.filter((d) => d.status === 'running');
    if (running.length) void Promise.allSettled(running.map((d) => post(`/api/playground/${d.id}/check`))).then(() => qc.invalidateQueries({ queryKey: ['playground'] }));
  }, [checked, list.data, qc]);
  useEffect(() => { if (logs !== null && !current && list.data) setLogs(null); }, [logs, current, list.data]);
  return (
    <>
      <PageHead title="Playground" icon={IconCloud}>
        <Button primary icon={IconPlus} disabled={!playgrounds.length} onClick={() => navigate('/playground/baru')}>Susunan baru</Button>
      </PageHead>
      <ol className="pg-how" aria-label="Cara kerja"><li><b>Susun</b><span className="lbl">Pilih bahan: web, database, Redis, load balancer.</span></li><li><b>Pasang</b><span className="lbl">Dipasang sungguhan di server uji setelah Anda setujui.</span></li><li><b>Ukur</b><span className="lbl">Uji beban dengan k6, lalu lihat di mana mulai jenuh.</span></li><li><b>Copot</b><span className="lbl">Semua dihapus bersih, termasuk data uji.</span></li></ol>
      <Note>Server uji tempat Anda memasang susunan Docker Compose (aplikasi, database, Redis, load balancer), menguji bebannya dengan <Link to="/uji-beban">Uji beban</Link>, lalu mencopotnya. Hasilnya diukur nyata, bukan simulasi. Hanya server yang ditandai <b>playground</b> yang bisa dipasangi.</Note>
      {servers.data && !playgrounds.length && (
        <Hint icon={IconInfo}><span>Belum ada server playground. Di halaman <Link to="/server">Server</Link>, ubah server uji Anda dan centang <b>Server playground</b>. Server itu harus punya Docker dengan Compose, dan <b>jangan</b> memakai server produksi.</span></Hint>
      )}
      <Async query={list}>{(rows) => rows.length
        ? <List>{rows.map((d) => <Row key={d.id} d={d} onLogs={(x) => setLogs(x.id)} />)}</List>
        : <div className="panel pg-empty"><h2>Mulai dari satu contoh</h2><p className="lbl">Belum ada susunan. Pilih contoh jadi (web + Redis, atau dua web di belakang load balancer), rakit dari image aplikasi Anda, atau tempel docker-compose.yml sendiri.</p><div className="row"><Button primary icon={IconPlus} disabled={!playgrounds.length} onClick={() => navigate('/playground/baru')}>Mulai dari contoh</Button></div></div>}
      </Async>
      <Modal open={current !== null} onClose={() => setLogs(null)}>{current && <LogsDialog d={current} onClose={() => setLogs(null)} />}</Modal>
    </>
  );
}

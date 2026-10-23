// Playground: pasang susunan Docker Compose di server uji (khusus uji), periksa kesehatannya, uji beban, lalu copot.
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { q, useAction } from '@/api/queries';
import type { Server } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Async } from '@/components/ui/Async';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Empty, Hint, Item, List, Note, PageHead } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconAlert, IconCheck, IconClose, IconCloud, IconGauge, IconInfo, IconList, IconPlay, IconPlus, IconTrash, IconWrench } from '@/components/icons';
import { del, get, post, put } from '@/lib/api';
import { useDebounced } from '@/lib/useDebounced';
import { BuilderPanel } from './BuilderPanel';
import { SAMPLES } from './samples';
import type { ComposeAnalysis, NewPlayground, PlaygroundDeploy, PlaygroundStatus } from './types';

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

function Analysis({ a }: { a: ComposeAnalysis | undefined }) {
  if (!a) return null;
  return (
    <div className="analysis" aria-live="polite">
      {a.problems.length > 0 && <Hint icon={IconAlert}><div><b>Belum bisa dipasang:</b><ul>{a.problems.map((p) => <li key={p}>{p}</li>)}</ul></div></Hint>}
      {a.problems.length === 0 && a.services.length > 0 && (
        <p className="lbl"><Badge tone="ok" icon={IconCheck}>valid</Badge> {a.services.length} layanan: {a.services.map((s) => s.name).join(', ')}{a.publish.length ? ` | port ${a.publish.map((p) => p.host).join(', ')}` : ''}</p>
      )}
      {a.warnings.length > 0 && <ul className="lbl">{a.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
    </div>
  );
}

function DeployForm({ servers, editing, onDone }: { servers: Server[]; editing: PlaygroundDeploy | null; onDone: () => void }) {
  const [f, setF] = useState<NewPlayground>(() => editing
    ? { server_id: editing.server_id, name: editing.name, compose: editing.compose, health_path: editing.health_path, target_port: editing.target_port }
    : { server_id: servers[0]?.id ?? 0, name: '', compose: '', health_path: '', target_port: 0 });
  const [building, setBuilding] = useState(false), debounced = useDebounced(f.compose, 400);
  const analysis = useQuery({ queryKey: ['playground', 'analyze', debounced], queryFn: () => post<ComposeAnalysis>('/api/playground/analyze', { compose: debounced }), enabled: debounced.trim() !== '', staleTime: Infinity });
  const a = f.compose.trim() === '' ? undefined : analysis.data;
  const save = useAction(() => (editing ? put(`/api/playground/${editing.id}`, { name: f.name, compose: f.compose, health_path: f.health_path, target_port: f.target_port }) : post('/api/playground', f)), {
    success: 'Disimpan. Tekan Pasang untuk memasangnya di server.', invalidate: [['playground']], onSuccess: onDone
  });
  const ready = f.name.trim() !== '' && f.compose.trim() !== '' && f.server_id > 0 && !!a && a.problems.length === 0 && debounced === f.compose;
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (ready) void save.mutateAsync(); }}>
      <h2><IconCloud size={16} aria-hidden />{editing ? `Ubah ${editing.name}` : 'Susunan baru'}</h2>
      <div className="cols tight">
        <Field label="Server playground"><select aria-label="Server playground" disabled={!!editing} value={f.server_id} onChange={(e) => setF({ ...f, server_id: Number(e.target.value) })}>{servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}</select></Field>
        <Field label="Nama susunan"><input placeholder="mis. web + redis" maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      </div>
      {building && <BuilderPanel onClose={() => setBuilding(false)} onBuilt={(compose, health) => setF((x) => ({ ...x, compose, health_path: health || x.health_path, name: x.name || 'susunan rakitan' }))} />}
      <Field label="docker-compose.yml" hint="Pakai image yang sudah jadi (bukan build). Image ditarik dari registry oleh server playground.">
        <textarea className="mono" aria-label="Isi Compose" style={{ minHeight: 220, fontSize: '.78rem' }} spellCheck={false} placeholder={'services:\n  web:\n    image: nginx:1.27\n    ports: ["8080:80"]'} value={f.compose} onChange={(e) => setF({ ...f, compose: e.target.value })} />
      </Field>
      <div className="row">
        <Button icon={IconWrench} onClick={() => setBuilding(true)}>Rakit dari komponen</Button>
        <span className="lbl">atau isi contoh:</span>
        {SAMPLES.map((s) => <Button key={s.id} onClick={() => setF({ ...f, compose: s.compose, health_path: s.health, name: f.name || s.label })}>{s.label}</Button>)}
      </div>
      <Analysis a={a} />
      <div className="cols tight">
        <Field label="Path cek kesehatan (opsional)" hint="Mis. /health. Kosong = hanya memastikan kontainer berjalan."><input className="mono" placeholder="/health" value={f.health_path} onChange={(e) => setF({ ...f, health_path: e.target.value })} /></Field>
        {a && a.publish.length > 1 && (
          <Field label="Port target uji beban"><select aria-label="Port target" value={f.target_port} onChange={(e) => setF({ ...f, target_port: Number(e.target.value) })}><option value={0}>Yang pertama ({a.publish[0]!.host})</option>{a.publish.map((p) => <option key={p.host} value={p.host}>{p.host} ({p.service})</option>)}</select></Field>
        )}
      </div>
      <div className="row"><button type="submit" className="primary" disabled={!ready || save.isPending}><IconCheck size={16} aria-hidden />Simpan</button><Button icon={IconClose} onClick={onDone}>Batal</Button></div>
    </form>
  );
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

function Row({ d, onEdit, onLogs }: { d: PlaygroundDeploy; onEdit: (d: PlaygroundDeploy) => void; onLogs: (d: PlaygroundDeploy) => void }) {
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
      {!busy && d.status !== 'running' && <Button icon={IconWrench} aria-label={`Ubah ${d.name}`} onClick={() => onEdit(d)} disabled={d.status === 'failed'} title={d.status === 'failed' ? 'Copot dulu sebelum mengubah' : undefined} />}
      {['draft', 'stopped'].includes(d.status) && <Button icon={IconTrash} aria-label={`Hapus ${d.name}`} onClick={async () => { if (await confirm(`Hapus susunan "${d.name}"?`, 'Hapus')) await remove.mutateAsync(); }} />}
    </Item>
  );
}

export function PlaygroundPage() {
  const list = useQuery(playgroundQ.list()), servers = useQuery(q.servers());
  const [dialog, setDialog] = useState<'baru' | PlaygroundDeploy | null>(null), [logs, setLogs] = useState<number | null>(null);
  const playgrounds = (servers.data ?? []).filter((s) => s.playground);
  const current = logs === null ? null : (list.data ?? []).find((d) => d.id === logs) ?? null;
  useEffect(() => { if (logs !== null && !current && list.data) setLogs(null); }, [logs, current, list.data]);
  return (
    <>
      <PageHead title="Playground" icon={IconCloud}>
        <Button primary icon={IconPlus} disabled={!playgrounds.length} onClick={() => setDialog('baru')}>Susunan baru</Button>
      </PageHead>
      <Note>Server uji tempat Anda memasang susunan Docker Compose (aplikasi, database, Redis, load balancer), menguji bebannya dengan <Link to="/uji-beban">Uji beban</Link>, lalu mencopotnya. Hasilnya diukur nyata, bukan simulasi. Hanya server yang ditandai <b>playground</b> yang bisa dipasangi.</Note>
      {servers.data && !playgrounds.length && (
        <Hint icon={IconInfo}><span>Belum ada server playground. Di halaman <Link to="/server">Server</Link>, ubah server uji Anda dan centang <b>Server playground</b>. Server itu harus punya Docker dengan Compose, dan <b>jangan</b> memakai server produksi.</span></Hint>
      )}
      <Async query={list}>{(rows) => rows.length
        ? <List>{rows.map((d) => <Row key={d.id} d={d} onEdit={setDialog} onLogs={(x) => setLogs(x.id)} />)}</List>
        : <Empty>Belum ada susunan. Tekan "Susunan baru", pilih contoh atau tempel docker-compose.yml Anda.</Empty>}
      </Async>
      <Modal open={dialog !== null} onClose={() => setDialog(null)}>
        <DeployForm key={dialog === 'baru' || dialog === null ? 'baru' : dialog.id} servers={playgrounds} editing={dialog === 'baru' || dialog === null ? null : dialog} onDone={() => setDialog(null)} />
      </Modal>
      <Modal open={current !== null} onClose={() => setLogs(null)}>{current && <LogsDialog d={current} onClose={() => setLogs(null)} />}</Modal>
    </>
  );
}

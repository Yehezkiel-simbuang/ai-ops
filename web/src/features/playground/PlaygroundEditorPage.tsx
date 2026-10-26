// Halaman menyusun (dan mengubah) satu susunan Playground: pilih bahan awal, atur isinya, tentukan server dan nama.
// Ringkasan "yang akan dipasang" ada di sisi kanan dan ikut berubah saat isinya diubah.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { q, useAction } from '@/api/queries';
import type { Server } from '@/api/types';
import { Async } from '@/components/ui/Async';
import { Step } from '@/components/ui/Step';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Fold } from '@/components/ui/Fold';
import { Empty, Hint, PageHead } from '@/components/ui/Layout';
import { IconAlert, IconCheck, IconClose, IconCloud, IconInfo } from '@/components/icons';
import { post, put } from '@/lib/api';
import { useDebounced } from '@/lib/useDebounced';
import { BuilderPanel } from './BuilderPanel';
import { playgroundQ } from './PlaygroundPage';
import { SAMPLES } from './samples';
import type { ComposeAnalysis, NewPlayground, PlaygroundDeploy } from './types';

type Start = string | 'builder' | 'yaml' | null;

/** Sama dengan aturan di server (service.ts); diperiksa di sini supaya kesalahannya terlihat sebelum Simpan. */
export const NAME_RE = /^[\w .-]+$/;

function Choice({ label, description, parts, selected, onPick }: { label: string; description: string; parts?: string[]; selected: boolean; onPick: () => void }) {
  return (
    <button type="button" className="pg-card" aria-pressed={selected} onClick={onPick}>
      <b>{label}</b>
      <span className="d">{description}</span>
      {parts && <span className="pg-chips">{parts.map((p, i) => <span key={`${p}${i}`} className="pg-chip">{p}</span>)}</span>}
    </button>
  );
}

/** Alur singkat dari pengguna sampai layanan di belakangnya, dibaca dari hasil analisis. */
function Flow({ a }: { a: ComposeAnalysis }) {
  const front = new Set(a.publish.map((p) => p.service)), rest = a.services.filter((s) => !front.has(s.name));
  return (
    <div className="pg-flow" aria-label="Alur lalu lintas">
      <span className="pg-chip">pengguna</span>
      {a.publish.length > 0 && <><span className="arrow" aria-hidden>›</span><span className="pg-chip">{a.publish.map((p) => `:${p.host} ${p.service}`).join(', ')}</span></>}
      {rest.length > 0 && <><span className="arrow" aria-hidden>›</span><span className="pg-chip">{rest.map((s) => s.name).join(', ')}</span></>}
    </div>
  );
}

function Preview({ a, pending, server }: { a: ComposeAnalysis | undefined; pending: boolean; server: Server | undefined }) {
  if (!a) return <p className="lbl">{pending ? 'Memeriksa...' : 'Pilih bahan awal di kiri. Di sini akan tampil apa saja yang akan dipasang.'}</p>;
  return (
    <div aria-live="polite">
      {a.problems.length > 0
        ? <Hint icon={IconAlert}><div><b>Belum bisa dipasang:</b><ul>{a.problems.map((p) => <li key={p}>{p}</li>)}</ul></div></Hint>
        : a.services.length > 0 && <p><Badge tone="ok" icon={IconCheck}>valid</Badge> <span className="lbl">{a.services.length} layanan</span></p>}
      {a.services.length > 0 && a.problems.length === 0 && <Flow a={a} />}
      {a.services.map((s) => (
        <div key={s.name} className="pg-svc">
          <b>{s.name}</b><span className="lbl">{s.ports.filter((p) => p.host).map((p) => `:${p.host}`).join(' ')}</span>
          <span className="pg-chip" style={{ gridColumn: '1 / -1', justifySelf: 'start' }}>{s.image}</span>
        </div>
      ))}
      {a.warnings.length > 0 && <ul className="lbl">{a.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      {server && a.problems.length === 0 && a.services.length > 0 && <p className="lbl" style={{ marginTop: 8 }}>Akan dipasang di <b>{server.name}</b> ({server.host}). Image ditarik dari internet oleh server itu.</p>}
    </div>
  );
}

function Composer({ servers, editing }: { servers: Server[]; editing: PlaygroundDeploy | null }) {
  const navigate = useNavigate();
  const [f, setF] = useState<NewPlayground>(() => editing
    ? { server_id: editing.server_id, name: editing.name, compose: editing.compose, health_path: editing.health_path, target_port: editing.target_port }
    : { server_id: servers[0]?.id ?? 0, name: '', compose: '', health_path: '', target_port: 0 });
  const [start, setStart] = useState<Start>(editing ? 'yaml' : null), [built, setBuilt] = useState(false), debounced = useDebounced(f.compose, 400);
  const analysis = useQuery({ queryKey: ['playground', 'analyze', debounced], queryFn: () => post<ComposeAnalysis>('/api/playground/analyze', { compose: debounced }), enabled: debounced.trim() !== '', staleTime: Infinity });
  const a = f.compose.trim() === '' ? undefined : analysis.data, server = servers.find((s) => s.id === f.server_id);
  const done = () => navigate('/playground');
  const save = useAction(() => (editing ? put(`/api/playground/${editing.id}`, { name: f.name, compose: f.compose, health_path: f.health_path, target_port: f.target_port }) : post('/api/playground', f)), {
    success: 'Disimpan. Tekan Pasang di daftar untuk memasangnya di server.', invalidate: [['playground']], onSuccess: done
  });
  const nameBad = f.name.trim() !== '' && !NAME_RE.test(f.name.trim());
  const ready = f.name.trim() !== '' && !nameBad && f.compose.trim() !== '' && f.server_id > 0 && !!a && a.problems.length === 0 && debounced === f.compose;
  const sample = SAMPLES.find((s) => s.id === start);
  const missing = !f.compose.trim() ? 'Pilih bahan awal atau isi docker-compose.yml.' : !f.name.trim() ? 'Beri nama susunan.' : nameBad ? 'Perbaiki nama susunan.' : a && a.problems.length ? 'Perbaiki masalah di atas.' : '';

  return (
    <form className="pg-layout" onSubmit={(e) => { e.preventDefault(); if (ready) void save.mutateAsync(); }}>
      <div className="pg-main panel">
        {!editing && (
          <Step n={1} title="Pilih bahan awal" hint="Tidak perlu paham Docker untuk mulai. Pilih contoh, rakit dari image aplikasi Anda, atau tempel docker-compose.yml sendiri. Isinya bisa diubah di langkah berikutnya.">
            <div className="pg-cards">
              {SAMPLES.map((s) => <Choice key={s.id} label={s.label} description={s.description} parts={s.parts} selected={start === s.id} onPick={() => { setStart(s.id); setBuilt(false); setF((x) => ({ ...x, compose: s.compose, health_path: s.health, name: x.name || s.name })); }} />)}
              <Choice label="Rakit dari aplikasi saya" description="Punya image Docker sendiri? Tambahkan database, Redis, beberapa replika, dan load balancer lewat formulir." selected={start === 'builder'} onPick={() => { setStart('builder'); setBuilt(false); setF((x) => ({ ...x, compose: '' })); }} />
              <Choice label="Tempel YAML sendiri" description="Sudah punya docker-compose.yml. Aplikasi memeriksa keamanannya sebelum dipasang." selected={start === 'yaml'} onPick={() => { setStart('yaml'); setBuilt(false); }} />
            </div>
          </Step>
        )}

        <Step n={editing ? 1 : 2} title={start === 'builder' ? 'Rakit susunan' : 'Atur isinya'} hint={start === null ? 'Muncul setelah Anda memilih bahan awal.' : undefined}>
          {start === 'builder' && !built && <BuilderPanel onClose={() => setStart((s) => (s === 'builder' ? null : s))} onBuilt={(compose, health) => { setF((x) => ({ ...x, compose, health_path: health || x.health_path, name: x.name || 'susunan rakitan' })); setBuilt(true); setStart('yaml'); }} />}
          {(sample || start === 'yaml') && (
            <Fold title={built ? 'Hasil rakitan (docker-compose.yml)' : sample ? 'Lihat atau ubah docker-compose.yml' : 'docker-compose.yml'} hint={sample ? 'Tidak wajib diubah' : undefined} open={start === 'yaml' || built || !!editing}>
              <Field label="docker-compose.yml" hint="Pakai image yang sudah jadi (bukan build). Image ditarik dari registry oleh server playground.">
                <textarea className="mono" aria-label="Isi Compose" style={{ minHeight: 240, fontSize: '.78rem' }} spellCheck={false} placeholder={'services:\n  web:\n    image: nginx:1.27\n    ports: ["8080:80"]'} value={f.compose} onChange={(e) => setF({ ...f, compose: e.target.value })} />
              </Field>
              {built && <div className="row"><Button onClick={() => { setBuilt(false); setStart('builder'); }}>Rakit ulang</Button></div>}
            </Fold>
          )}
        </Step>

        <Step n={editing ? 2 : 3} title="Server dan nama" hint="Server harus yang ditandai playground (server uji, bukan produksi).">
          <div className="cols tight">
            <Field label="Server playground"><select aria-label="Server playground" disabled={!!editing} value={f.server_id} onChange={(e) => setF({ ...f, server_id: Number(e.target.value) })}>{servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}</select></Field>
            <Field label="Nama susunan" hint={nameBad ? undefined : 'Huruf, angka, spasi, titik, minus, dan garis bawah.'}><input placeholder="mis. web-redis-uji" maxLength={60} aria-invalid={nameBad} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />{nameBad && <p className="lbl" role="alert" style={{ color: 'var(--bad)' }}>Nama hanya boleh huruf, angka, spasi, titik, minus, dan garis bawah. Ganti tanda lain, misalnya + menjadi "dan".</p>}</Field>
          </div>
          <Fold title="Pengaturan uji (opsional)" hint="Cek kesehatan dan port target uji beban">
            <div className="cols tight">
              <Field label="Path cek kesehatan (opsional)" hint="Mis. /health. Kosong = hanya memastikan kontainer berjalan."><input className="mono" placeholder="/health" value={f.health_path} onChange={(e) => setF({ ...f, health_path: e.target.value })} /></Field>
              {a && a.publish.length > 1 && (
                <Field label="Port target uji beban"><select aria-label="Port target" value={f.target_port} onChange={(e) => setF({ ...f, target_port: Number(e.target.value) })}><option value={0}>Yang pertama ({a.publish[0]!.host})</option>{a.publish.map((p) => <option key={p.host} value={p.host}>{p.host} ({p.service})</option>)}</select></Field>
              )}
            </div>
          </Fold>
        </Step>
      </div>

      <aside className="pg-aside panel" aria-label="Ringkasan">
        <h2>Yang akan dipasang</h2>
        <Preview a={a} pending={analysis.isFetching} server={server} />
        <div className="pg-next">
          <b>Setelah disimpan</b>
          <ol className="lbl"><li>Tekan <b>Pasang</b> di daftar. Anda diminta menyetujui ringkasannya dulu.</li><li>Tekan <b>Uji beban</b> untuk mengukur susunan ini.</li><li>Tekan <b>Copot</b> bila selesai. Kontainer dan data ujinya dihapus.</li></ol>
        </div>
        {missing && <p className="lbl" role="status">{missing}</p>}
        <div className="row"><button type="submit" className="primary" disabled={!ready || save.isPending}><IconCheck size={16} aria-hidden />Simpan</button><Button icon={IconClose} onClick={done}>Batal</Button></div>
      </aside>
    </form>
  );
}

export function PlaygroundEditorPage() {
  const { id } = useParams(), list = useQuery(playgroundQ.list()), servers = useQuery(q.servers());
  const creating = id === 'baru', playgrounds = (servers.data ?? []).filter((s) => s.playground);
  const editing = creating ? null : (list.data ?? []).find((d) => d.id === Number(id)) ?? null;
  return (
    <>
      <PageHead title={creating ? 'Susunan baru' : 'Ubah susunan'} icon={IconCloud}><Link to="/playground">Kembali ke daftar</Link></PageHead>
      <Async query={servers}>{() => {
        if (!playgrounds.length) return <Hint icon={IconInfo}><span>Belum ada server playground. Di halaman <Link to="/server">Server</Link>, ubah server uji Anda dan centang <b>Server playground</b>. Server itu harus punya Docker dengan Compose, dan <b>jangan</b> memakai server produksi.</span></Hint>;
        if (!creating && !list.data) return <Empty>Memuat...</Empty>;
        if (!creating && !editing) return <Empty>Susunan ini tidak ditemukan. <Link to="/playground">Kembali ke daftar</Link>.</Empty>;
        if (editing && ['running', 'deploying', 'stopping', 'failed'].includes(editing.status)) return <Empty>Susunan yang sedang terpasang tidak bisa diubah. Copot dulu dari daftar. <Link to="/playground">Kembali ke daftar</Link>.</Empty>;
        return <Composer key={editing?.id ?? 'baru'} servers={playgrounds} editing={editing} />;
      }}</Async>
    </>
  );
}

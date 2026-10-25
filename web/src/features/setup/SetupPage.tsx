import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { q, useAction } from '@/api/queries';
import type { NewRun, Run, RunTemplate, Server } from '@/api/types';
import { RunStatusBadge } from '@/components/StatusBadges';
import { Async } from '@/components/ui/Async';
import { Button } from '@/components/ui/Button';
import { Empty, Hint, Item, List, PageHead } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { Field, useForm } from '@/components/ui/Field';
import { IconHistory, IconPlus, IconWrench } from '@/components/icons';
import { post } from '@/lib/api';
import { ago, fmt } from '@/lib/format';

function RunList({ runs }: { runs: Run[] }) {
  if (!runs.length) return <Empty>Belum ada proses.</Empty>;
  return (
    <List>{runs.map((r) => {
      const done = r.steps.filter((s) => s.status === 'done').length;
      return <Item key={r.id} to={`/setup/${r.id}`} title={r.name} sub={[`${r.server_name ?? 'tanpa server'} | ${ago(r.updated)} | ${fmt(r.tokens)} token${r.steps.length ? ` | langkah ${done}/${r.steps.length}` : ''}`]}><RunStatusBadge status={r.status} /></Item>;
    })}</List>
  );
}

function NewRunForm({ servers, templates }: { servers: Server[]; templates: RunTemplate[] }) {
  const navigate = useNavigate();
  const { values, bind, set } = useForm({ serverId: servers[0]?.id ?? 0, name: '', goal: '', dir: '', maxTurns: 30, tokenBudget: 200000 });
  const [template, setTemplate] = useState<RunTemplate | null>(null);
  const create = useAction(
    () => post<{ id: string }>('/api/runs', { ...values, serverId: Number(values.serverId), maxTurns: Number(values.maxTurns), tokenBudget: Number(values.tokenBudget), dir: String(values.dir).trim(), template: template?.id ?? null } satisfies NewRun),
    { invalidate: [['runs'], ['overview']], onSuccess: (r) => navigate(`/setup/${r.id}`) }
  );
  const pick = (t: RunTemplate) => {
    const next = template?.id === t.id ? null : t;
    setTemplate(next); set('goal', next?.goal ?? ''); set('name', next?.name ?? '');
    set('maxTurns', next?.maxTurns ?? 30); set('tokenBudget', next?.tokenBudget ?? 200000);   // pemasangan butuh lebih banyak giliran daripada diagnosis
  };
  const groups = [...templates.reduce((m, t) => m.set(t.category ?? 'Lainnya', [...(m.get(t.category ?? 'Lainnya') ?? []), t]), new Map<string, RunTemplate[]>())];
  const unfilled = String(values.goal).match(/\[ISI:[^\]]*\]/);   // bagian templat yang belum diganti; server juga menolaknya
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <h2><IconPlus size={16} aria-hidden />Proses baru</h2>
      {servers.length
        ? <Field label="Server"><select aria-label="Server tujuan" {...bind('serverId')}>{servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}</select></Field>
        : <Hint><Link to="/server">Tambahkan server dulu</Link></Hint>}
      {/* bukan <label>: tombol di dalam label membuat nama tiap tombol menjadi seluruh teks label */}
      <div className="field" role="group" aria-labelledby="tpl-label">
        <span id="tpl-label">Mulai dari templat (opsional)</span>
        <div className="stack">{groups.map(([cat, list]) => (
          <div key={cat} role="group" aria-label={cat}>
            <div className="lbl" style={{ marginBottom: 4 }}>{cat}</div>
            <div className="chips">{list.map((t) => <button key={t.id} type="button" aria-pressed={template?.id === t.id} onClick={() => pick(t)}>{t.name}</button>)}</div>
          </div>
        ))}</div>
        <span className="lbl">Pilih satu untuk mengisi tujuan dan rencana langkahnya. Templat pemasangan meminta Anda mengganti bagian [ISI: ...] di tujuan.</span>
      </div>
      {template?.ask?.length ? <Hint><span>Yang perlu Anda isi di Tujuan: {template.ask.join(', ')}. Agen tidak menebak nilainya.</span></Hint> : null}
      <Field label="Nama (opsional)"><input placeholder="otomatis" {...bind('name')} /></Field>
      <Field label="Tujuan"><textarea style={template ? { minHeight: 260 } : undefined} placeholder="Contoh: Diagnosis lalu tuning MySQL dan PHP-FPM agar login tidak 504. Jangan restart layanan di jam kerja." {...bind('goal')} /></Field>
      <Field label="Folder proyek" hint="Bila diisi, rencana langkah dibuat dari analisis proyek (rekomendasi lengkap dengan bukti)."><input className="mono" placeholder="D:\work\Proyek (opsional: rencana dibuat dari analisis kode)" {...bind('dir')} /></Field>
      <div className="cols tight">
        <Field label="Maks. giliran agen"><input type="number" min={3} max={100} {...bind('maxTurns')} /></Field>
        <Field label="Anggaran token"><input type="number" min={5000} step={5000} {...bind('tokenBudget')} /></Field>
      </div>
      {unfilled && <p className="lbl" role="alert" style={{ color: 'var(--bad)' }}>Tujuan masih berisi {unfilled[0]}. Ganti dengan nilai sebenarnya (atau tulis "tidak ada") sebelum membuat proses.</p>}
      <div className="row"><button type="submit" className="primary" disabled={create.isPending || !servers.length || !!unfilled}><IconPlus size={16} aria-hidden />Buat proses</button></div>
      <p className="lbl">Membuat proses tidak menjalankan apa pun. Agen baru bekerja setelah Anda menekan Mulai, dan setiap perubahan tetap menunggu persetujuan Anda.</p>
    </form>
  );
}

export function SetupPage() {
  const runs = useQuery(q.runs()), servers = useQuery(q.servers()), templates = useQuery(q.runTemplates()), [open, setOpen] = useState(false);
  return (
    <>
      <PageHead title="Setup server" icon={IconWrench}><Button primary icon={IconPlus} onClick={() => setOpen(true)}>Proses baru</Button></PageHead>
      <h2><IconHistory size={16} aria-hidden />Riwayat</h2>
      <Async query={runs}>{(r) => <RunList runs={r} />}</Async>
      <Modal open={open} onClose={() => setOpen(false)}>
        {servers.data && templates.data ? <NewRunForm servers={servers.data} templates={templates.data} /> : <Empty>Memuat...</Empty>}
      </Modal>
    </>
  );
}

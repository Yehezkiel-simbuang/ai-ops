// Dialog "Proses baru" dalam dua blok: kiri memilih templat (dengan pencarian), kanan mengatur prosesnya.
// Templat pemasangan memuat bagian [ISI: ...] di tujuan yang wajib diganti; server juga menolaknya.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAction } from '@/api/queries';
import type { NewRun, RunTemplate, Server } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, useForm } from '@/components/ui/Field';
import { Fold } from '@/components/ui/Fold';
import { Hint } from '@/components/ui/Layout';
import { IconClose, IconPlus } from '@/components/icons';
import { post } from '@/lib/api';

const HOLE = /\[ISI:[^\]]*\]/;
const meta = (t: RunTemplate): string => `${t.steps.length} langkah${t.ask?.length ? ` | perlu Anda isi: ${t.ask.length}` : ''}`;

function TemplatePicker({ templates, value, onPick }: { templates: RunTemplate[]; value: RunTemplate | null; onPick: (t: RunTemplate) => void }) {
  const [term, setTerm] = useState(''), needle = term.trim().toLowerCase();
  const shown = templates.filter((t) => !needle || `${t.name} ${t.category ?? ''} ${t.id}`.toLowerCase().includes(needle));
  const groups = [...shown.reduce((m, t) => m.set(t.category ?? 'Lainnya', [...(m.get(t.category ?? 'Lainnya') ?? []), t]), new Map<string, RunTemplate[]>())];
  return (
    <section className="setup-block setup-pick" aria-label="Pilih templat">
      <h3>1. Pilih templat <span className="lbl">(opsional)</span></h3>
      <input type="search" aria-label="Cari templat" placeholder="Cari: postgres, laravel, redis, load balancer..." value={term} onChange={(e) => setTerm(e.target.value)} />
      <div className="stack">
        {groups.map(([cat, list]) => (
          <div key={cat} role="group" aria-label={cat}>
            <div className="lbl" style={{ margin: '4px 0' }}>{cat}</div>
            <div className="stack">{list.map((t) => (
              <button key={t.id} type="button" className="tpl" aria-pressed={value?.id === t.id} aria-labelledby={`tpl-${t.id}`} aria-describedby={`tpl-${t.id}-m`} onClick={() => onPick(t)}>
                <span id={`tpl-${t.id}`}>{t.name}</span><span className="lbl" id={`tpl-${t.id}-m`}>{meta(t)}</span>
              </button>))}</div>
          </div>
        ))}
        {!shown.length && <p className="lbl">Tidak ada templat yang cocok. Anda tetap bisa menulis tujuan sendiri di blok sebelah.</p>}
      </div>
    </section>
  );
}

export function NewRunForm({ servers, templates, onClose }: { servers: Server[]; templates: RunTemplate[]; onClose: () => void }) {
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
  const unfilled = String(values.goal).match(HOLE);   // bagian templat yang belum diganti; server juga menolaknya
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <h2><IconPlus size={16} aria-hidden />Proses baru</h2>
      <div className="setup-split">
        <TemplatePicker templates={templates} value={template} onPick={pick} />
        <section className="setup-block" aria-label="Atur proses">
          <h3>2. Atur proses</h3>
          {servers.length
            ? <Field label="Server"><select aria-label="Server tujuan" {...bind('serverId')}>{servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}</select></Field>
            : <Hint><Link to="/server">Tambahkan server dulu</Link></Hint>}
          {template
            ? (
              <div className="tpl-chosen">
                <div className="row"><b>{template.name}</b>{template.category && <Badge>{template.category}</Badge>}</div>
                {template.ask?.length ? <p className="lbl">Yang perlu Anda isi di Tujuan: {template.ask.join(', ')}. Agen tidak menebak nilainya.</p> : null}
                <Fold title="Rencana langkah" hint={`${template.steps.length} langkah`}><ol className="lbl" style={{ margin: 0, paddingLeft: 18 }}>{template.steps.map((s) => <li key={s}>{s}</li>)}</ol></Fold>
              </div>
            )
            : <p className="lbl">Pilih templat di blok kiri, atau tulis tujuan sendiri di bawah.</p>}
          <Field label="Nama (opsional)"><input placeholder="otomatis" {...bind('name')} /></Field>
          <Field label="Tujuan"><textarea style={{ minHeight: template ? 240 : 110 }} placeholder="Contoh: Diagnosis lalu tuning MySQL dan PHP-FPM agar login tidak 504. Jangan restart layanan di jam kerja." {...bind('goal')} /></Field>
          <Field label="Folder proyek" hint="Bila diisi, rencana langkah dibuat dari analisis proyek (rekomendasi lengkap dengan bukti)."><input className="mono" placeholder="D:\work\Proyek (opsional: rencana dibuat dari analisis kode)" {...bind('dir')} /></Field>
          <div className="cols tight">
            <Field label="Maks. giliran agen"><input type="number" min={3} max={100} {...bind('maxTurns')} /></Field>
            <Field label="Anggaran token"><input type="number" min={5000} step={5000} {...bind('tokenBudget')} /></Field>
          </div>
          {unfilled && <p className="lbl" role="alert" style={{ color: 'var(--bad)' }}>Tujuan masih berisi {unfilled[0]}. Ganti dengan nilai sebenarnya (atau tulis "tidak ada") sebelum membuat proses.</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={create.isPending || !servers.length || !!unfilled}><IconPlus size={16} aria-hidden />Buat proses</button>
            <Button icon={IconClose} onClick={onClose}>Batal</Button>
          </div>
          <p className="lbl">Membuat proses tidak menjalankan apa pun. Agen baru bekerja setelah Anda menekan Mulai, dan setiap perubahan tetap menunggu persetujuan Anda.</p>
        </section>
      </div>
    </form>
  );
}

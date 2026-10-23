// Standar pemantauan GLOBAL: batas Minor, Major, dan Critical tiap pemeriksaan, berlaku untuk semua server. Isi awalnya bawaan aplikasi,
// bisa diubah di sini atau diusulkan AI dari data 7 hari. Server memakai standar ini langsung; tidak ada salinan per server.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAction } from '@/api/queries';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Fold } from '@/components/ui/Fold';
import { Hint, Note, PageHead } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import type { Level } from '@/api/types';
import { LABEL, LEVELS, MEANING } from '@/lib/levels';
import { LevelBadge } from '@/components/StatusBadges';
import { IconCheck, IconClose, IconInfo, IconReset, IconScale, IconSpark, IconTrash } from '@/components/icons';
import { del, get, post, put } from '@/lib/api';
import { Meter, fmtNum, type Stat } from './Meter';

export interface Def { minor: number | null; warn: number | null; crit: number | null; confirm: number | null }
export interface Row { key: string; label?: string; name?: string; description?: string; typeLabel?: string; unit: string; dir: 'gt' | 'lt'; min?: number; max?: number; numeric: boolean; minor: number | null; warn: number | null; crit: number | null; confirm: number | null; default: Def; custom: boolean; stats: (Stat & { servers?: number }) | null; servers: number }
export interface EventRow { key: string; label: string; description: string; level: Level; default: Level; custom: boolean }
export interface Standards { base: Row[]; agent?: Row[]; events?: EventRow[]; packs: Array<{ id: string; label: string; category?: 'umum' | 'aplikasi'; custom?: boolean; unit?: string | null; checks: Row[] }> }
export interface Proposal { key: string; name: string; unit: string; current: { minor: number | null; warn: number | null; crit: number | null }; minor: number | null; warn: number | null; crit: number | null; why: string; problem: string }

const str = (n: number | null): string => (n === null ? '' : String(n));
const triple = (v: { minor: number | null; warn: number | null; crit: number | null }): string => [v.minor, v.warn, v.crit].map((x) => (x === null ? '-' : fmtNum(x))).join(' / ');
const num = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const dirText = (d: 'gt' | 'lt') => (d === 'gt' ? 'Bahaya bila nilai NAIK melewati ambang' : 'Bahaya bila nilai TURUN di bawah ambang');

/** Pesan masalah untuk batas Major (warn) dan Critical (crit), dengan Minor opsional; null bila boleh disimpan. Aturannya sama dengan di server. */
export function limitProblem(dir: 'gt' | 'lt', warn: string, crit: string, opt: { min?: number; max?: number; requireWarn?: boolean; minor?: string } = {}): string | null {
  const m = num(opt.minor ?? ''), w = num(warn), c = num(crit);
  if ([m, w, c].some((v) => v !== null && !Number.isFinite(v))) return 'Isi dengan angka';
  if (opt.requireWarn && w === null) return 'Batas Major wajib diisi';
  for (const v of [m, w, c]) if (v !== null && ((opt.min !== undefined && v < opt.min) || (opt.max !== undefined && v > opt.max))) return `Nilai harus antara ${opt.min} dan ${opt.max}`;
  const steps = ([['Minor', m], ['Major', w], ['Critical', c]] as Array<[string, number | null]>).filter((x) => x[1] !== null) as Array<[string, number]>;
  for (let i = 1; i < steps.length; i++) {
    const [pn, pv] = steps[i - 1]!, [cn, cv] = steps[i]!;
    if (dir === 'lt' ? cv > pv : cv < pv) return dir === 'lt' ? `${cn} harus sama atau lebih rendah dari ${pn} (bahaya bila turun)` : `${cn} harus sama atau lebih tinggi dari ${pn}`;
  }
  return null;
}

function StdCard({ r, isBase, meter = true }: { r: Row; isBase: boolean; meter?: boolean }) {
  const [minor, setMinor] = useState(str(r.minor)), [warn, setWarn] = useState(str(r.warn)), [crit, setCrit] = useState(str(r.crit)), [conf, setConf] = useState(String(r.confirm ?? 2));
  const title = r.label ?? r.name ?? r.key, problem = limitProblem(r.dir, warn, crit, { min: r.min, max: r.max, requireWarn: isBase, minor });
  const confBad = !isBase && !(Number(conf) >= 1 && Number(conf) <= 10), dirty = minor !== str(r.minor) || warn !== str(r.warn) || crit !== str(r.crit) || (!isBase && conf !== String(r.confirm ?? 2));
  const save = useAction(() => put('/api/standards', { key: r.key, minor: num(minor), warn: num(warn), crit: num(crit), confirm: isBase ? null : Number(conf) }), { success: 'Standar disimpan, berlaku di semua server', invalidate: [['standards']] });
  const reset = useAction(() => put('/api/standards', { key: r.key, reset: true }), { success: 'Dikembalikan ke bawaan', invalidate: [['standards']] });
  return (
    <section className="panel limit-card" aria-label={title}>
      <h3>{title} {r.custom ? <Badge tone="acc">diubah</Badge> : <Badge tone="mute">bawaan</Badge>}</h3>
      <p className="lbl">{r.description ?? r.typeLabel}{r.servers > 0 ? ` | dipakai di ${r.servers} server` : ''}</p>
      {meter && <Meter dir={r.dir} minor={num(minor)} warn={num(warn)} crit={num(crit)} stat={r.stats} value={null} unit={r.unit} />}
      <div className="row">
        <Field label={`Minor ${r.dir === 'gt' ? 'di atas' : 'di bawah'} (${r.unit})`}><input type="number" step="any" aria-label="Batas Minor" value={minor} placeholder="kosong = tanpa Minor" onChange={(e) => setMinor(e.target.value)} /></Field>
        <Field label={`Major ${r.dir === 'gt' ? 'di atas' : 'di bawah'} (${r.unit})`}><input type="number" step="any" aria-label="Batas Major" value={warn} onChange={(e) => setWarn(e.target.value)} /></Field>
        <Field label={`Critical ${r.dir === 'gt' ? 'di atas' : 'di bawah'} (${r.unit})`}><input type="number" step="any" aria-label="Batas Critical" value={crit} placeholder="kosong = tanpa Critical" onChange={(e) => setCrit(e.target.value)} /></Field>
        {!isBase && <Field label="Beri tahu setelah (kali)"><input type="number" min={1} max={10} aria-label="Konfirmasi" value={conf} onChange={(e) => setConf(e.target.value)} /></Field>}
      </div>
      <p className="lbl">{dirText(r.dir)}</p>
      {problem && <p className="err" role="alert">{problem}</p>}
      <div className="row">
        <Button primary icon={IconCheck} disabled={!dirty || !!problem || confBad} onClick={() => save.mutateAsync()}>Simpan</Button>
        {r.custom && <Button icon={IconReset} onClick={() => reset.mutateAsync()}>Pulihkan bawaan ({r.default.minor !== null ? `${fmtNum(r.default.minor)} / ` : ''}{fmtNum(r.default.warn ?? 0)}{r.default.crit !== null ? ` / ${fmtNum(r.default.crit)}` : ''})</Button>}
      </div>
    </section>
  );
}

/** Tingkat tiap jenis kejadian dari agen. Berbeda dari batas angka: kejadian seperti akun baru atau kunci berubah punya tingkat tetap menurut jenisnya. */
function EventLevels({ events }: { events: EventRow[] }) {
  const set = useAction((b: { key: string; level?: Level; reset?: boolean }) => put('/api/standards/event', b), { success: 'Disimpan', invalidate: [['standards']] });
  return (
    <section aria-label="Tingkat kejadian dari agen">
      <h2 className="mt">Tingkat kejadian dari agen</h2>
      <p className="lbl">Kejadian perubahan tidak memakai batas angka: tingkatnya mengikuti jenis kejadian. {LEVELS.map((l) => `${LABEL[l]} = ${MEANING[l]}`).join('; ')}.</p>
      <ul className="events">
        {events.map((e) => (
          <li key={e.key} className="panel" style={{ marginBottom: 8 }}>
            <div className="row">
              <div className="grow"><b>{e.label}</b> <LevelBadge level={e.level} />{e.custom && <> <Badge tone="acc">diubah</Badge></>}<div className="lbl">{e.description}</div></div>
              <select aria-label={`Tingkat ${e.label}`} value={e.level} onChange={(ev) => set.mutate({ key: e.key, level: ev.target.value as Level })}>{LEVELS.map((l) => <option key={l} value={l}>{LABEL[l]}</option>)}</select>
              {e.custom && <Button icon={IconReset} onClick={() => set.mutate({ key: e.key, reset: true })}>Pulihkan ({LABEL[e.default]})</Button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Usulan AI: ditinjau dulu, baru yang dicentang disimpan. Tidak ada yang tersimpan otomatis. */
function AiDialog({ onClose }: { onClose: () => void }) {
  const [res, setRes] = useState<{ proposals: Proposal[]; model: string; withData: number; total: number } | null>(null), [picked, setPicked] = useState<Set<string>>(new Set());
  const ask = useAction(() => post<{ proposals: Proposal[]; model: string; withData: number; total: number }>('/api/standards/suggest', {}), { onSuccess: (r) => { setRes(r); setPicked(new Set(r.proposals.filter((p) => !p.problem).map((p) => p.key))); } });
  const apply = useAction(async () => { for (const p of res!.proposals.filter((x) => picked.has(x.key))) await put('/api/standards', { key: p.key, minor: p.minor, warn: p.warn, crit: p.crit }); }, { success: 'Usulan diterapkan', invalidate: [['standards']], onSuccess: onClose });
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div className="form">
      <h2><IconSpark size={16} aria-hidden />Usulan AI untuk standar</h2>
      <p className="lbl">AI membaca data nyata 7 hari dari server Anda (min, rata-rata, p95, maks) dan mengusulkan ambang di atas kebiasaan normal. Yang datanya kurang dari 30 sampel dibiarkan. Ini tebakan terarah: tinjau sebelum menerapkan.</p>
      {!res && <div className="row"><Button primary icon={IconSpark} onClick={() => ask.mutateAsync()}>Minta usulan</Button><Button icon={IconClose} onClick={onClose}>Batal</Button></div>}
      {res && (
        <>
          <p className="lbl">Ditulis AI ({res.model}). Data cukup untuk {res.withData} dari {res.total} pemeriksaan.</p>
          {res.proposals.length === 0 && <Note>Tidak ada perubahan yang diusulkan. Nilai sekarang sudah sesuai data, atau datanya belum cukup.</Note>}
          <ul className="plain" style={{ maxHeight: 360, overflow: 'auto' }}>
            {res.proposals.map((p) => (
              <li key={p.key} style={{ padding: '6px 0' }}>
                <label className="checkline"><input type="checkbox" aria-label={`Terapkan ${p.name}`} disabled={!!p.problem} checked={picked.has(p.key)} onChange={() => toggle(p.key)} />
                  <span><b>{p.name}</b> (Minor / Major / Critical): {triple(p.current)} menjadi <b>{triple(p)}</b> {p.unit}</span></label>
                <div className="lbl">{p.problem ? <span className="err">{p.problem}</span> : p.why}</div>
              </li>
            ))}
          </ul>
          <div className="row"><Button primary icon={IconCheck} disabled={!picked.size} onClick={() => apply.mutateAsync()}>Terapkan {picked.size || ''} yang dipilih</Button><Button icon={IconClose} onClick={onClose}>Tutup</Button></div>
        </>
      )}
    </div>
  );
}

/** Menghapus layanan buatan sendiri dari Standar. Pemeriksaan yang sudah terpasang di server tetap jalan dengan nilainya sendiri. */
function RemoveService({ id, label }: { id: string; label: string }) {
  const { confirm } = useDialogs();
  const remove = useAction(async () => { if (await confirm(`Hapus ${label} dari Standar? Pemeriksaan yang sudah terpasang di server tetap berjalan, tetapi tidak lagi mengikuti Standar.`, 'Hapus')) await del(`/api/standards/packs/${id}`); }, { invalidate: [['standards']] });
  return <Button icon={IconTrash} aria-label={`Hapus ${label} dari standar`} onClick={() => remove.mutateAsync()} />;
}

export function StandardsPage() {
  const data = useQuery({ queryKey: ['standards'], queryFn: () => get<Standards>('/api/standards'), refetchInterval: 60_000 }), [ai, setAi] = useState(false);
  return (
    <>
      <PageHead title="Standar pemantauan" icon={IconScale}><Button icon={IconSpark} onClick={() => setAi(true)}>Buat dengan AI</Button></PageHead>
      <Fold title="Cara kerja standar" hint="berlaku untuk semua server">
        <Note>Satu pengaturan untuk <b>semua server</b>: kapan sebuah nilai dianggap peringatan atau kritis. Mengubahnya di sini langsung berlaku di semua server, tanpa mengatur satu per satu. Angka bawaan adalah nilai umum dari aplikasi, bukan hasil ukur server Anda; garis ukur di tiap kartu menunjukkan data nyata 7 hari supaya Anda bisa memilih ambang di atas kebiasaan normal.</Note>
        <Hint icon={IconInfo}><span>Layanan di server yang belum ada di daftar ini bisa ditambahkan: buka <b>Monitor</b> server, pilih <b>Layanan di server</b>, lalu <b>Tambahkan ke standar</b>. Setelah itu ia muncul di sini dan dikenali di semua server.</span></Hint>
        <Hint icon={IconInfo}><span>Hal yang bergantung pada tiap server, seperti <b>dijalankan sebagai sudo</b>, diatur di <Link to="/server">halaman Server</Link>. Pemeriksaan kustom yang Anda buat sendiri memakai ambangnya sendiri di halaman Monitor.</span></Hint>
      </Fold>
      <Async query={data}>{(d) => (
        <>
          <h2>Pemeriksaan dasar server</h2>
          <div className="limit-grid">{d.base.map((r) => <StdCard key={`${r.key}-${r.minor}-${r.warn}-${r.crit}`} r={r} isBase />)}</div>
          {d.agent && d.agent.length > 0 && (
            <>
              <h2 className="mt">Dihitung oleh agen</h2>
              <p className="lbl">Batas ini dikirim ke semua agen di server, jadi satu pengaturan berlaku untuk semuanya.</p>
              <div className="limit-grid">{d.agent.map((r) => <StdCard key={`${r.key}-${r.minor}-${r.warn}-${r.crit}`} r={r} isBase meter={false} />)}</div>
            </>
          )}
          {d.events && d.events.length > 0 && <EventLevels events={d.events} />}
          {([['umum', 'Layanan umum', 'Layanan yang sama artinya di server mana pun: database, web server, cache, dan sejenisnya. Hanya berlaku di server yang memang punya layanannya.'], ['aplikasi', 'Aplikasi dan khusus proyek', 'Khusus satu aplikasi atau yang Anda tambahkan sendiri. Tidak dideteksi otomatis; pasang di server yang memakainya.']] as const).map(([cat, title, about]) => {
            const packs = d.packs.filter((g) => (g.category ?? 'umum') === cat); if (!packs.length) return null;
            return <section key={cat} aria-label={title}><h2 className="mt">{title}</h2><p className="lbl">{about}</p>{packs.map((g) => {
            const numeric = g.checks.filter((c) => c.numeric), onoff = g.checks.filter((c) => !c.numeric);
            return (
              <details key={g.id} className="group">
                <summary><b>{g.label}</b>{g.custom && <> <Badge tone="acc">buatan sendiri</Badge> <RemoveService id={g.id} label={g.label} /></>}<span className="lbl">{numeric.length} dengan ambang{onoff.length ? `, ${onoff.length} hidup atau mati` : ''}</span></summary>
                {numeric.length > 0 ? <div className="limit-grid">{numeric.map((c) => <StdCard key={`${c.key}-${c.warn}-${c.crit}-${c.confirm}`} r={c} isBase={false} />)}</div> : <p className="lbl" style={{ margin: '8px 0' }}>Semua pemeriksaan di paket ini hanya hidup atau mati, jadi tidak ada ambang.</p>}
              </details>
            );
          })}</section>;
          })}
        </>
      )}</Async>
      <Modal open={ai} onClose={() => setAi(false)}><AiDialog onClose={() => setAi(false)} /></Modal>
    </>
  );
}

// Semua layanan yang berjalan di server (hasil pemindaian), dengan pilihan memantau (hidup atau mati), saran perintah dari AI,
// dan tombol Coba: perintah dijalankan sekali di server dan keluarannya ditampilkan sebelum disimpan. Perintah selalu baca-saja.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAction } from '@/api/queries';
import { Async } from '@/components/ui/Async';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Hint, Note } from '@/components/ui/Layout';
import { IconBolt, IconCheck, IconClose, IconEye, IconInfo, IconScale, IconSpark } from '@/components/icons';
import { get, post, put } from '@/lib/api';

export interface ScanService { unit: string; pack: string | null; noise: boolean }
interface ScanResult { services: ScanService[]; ports: number[] }
export interface TryResult { command: string; exitCode: number; ms: number; timedOut: boolean; stdout: string; stderr: string; evaluation: { status: string; value: number | null; detail: string } }
interface Suggestion { unit: string; title: string; command: string; why: string; readOnly: boolean; problem: string }

const TONE: Record<string, [Tone, string]> = { ok: ['ok', 'Normal'], warn: ['warn', 'Peringatan'], crit: ['bad', 'Kritis'], unknown: ['mute', 'Tidak terbaca'] };

interface StdCheck { name: string; type: string; params: Record<string, unknown>; warn?: number | null; crit?: number | null; confirm?: number }
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const customCheck = (unit: string, title: string, command: string, warn: string, crit: string): StdCheck => ({ name: `${unit}: ${title}`, type: 'custom', params: { command }, warn: numOrNull(warn), crit: numOrNull(crit), confirm: 2 });

/** Nama pemeriksaan "layanan aktif" untuk satu unit. */
export const activeCheckName = (unit: string): string => `Layanan ${unit} aktif`;

/** Perintah + Coba + Simpan. `onSave` menerima perintah dan ambang; `saveLabel` menyesuaikan konteks (baru atau ubah). */
export function CommandTester({ serverId, initial, warn, crit, saveLabel, onSave, alt }: { serverId: number; initial: string; warn?: string; crit?: string; saveLabel: string; onSave: (command: string, warn: string, crit: string) => Promise<unknown>; alt?: { label: string; onSave: (command: string, warn: string, crit: string) => Promise<unknown> } }) {
  const [command, setCommand] = useState(initial), [w, setW] = useState(warn ?? ''), [c, setC] = useState(crit ?? ''), [result, setResult] = useState<TryResult | null>(null);
  const body = () => ({ type: 'custom', params: { command }, warn: w.trim() === '' ? null : Number(w), crit: c.trim() === '' ? null : Number(c) });
  const run = useAction(() => post<TryResult>(`/api/servers/${serverId}/checks/try`, body()), { onSuccess: setResult });
  const [tone, label] = TONE[result?.evaluation.status ?? 'unknown']!;
  return (
    <div className="form">
      <textarea className="mono" aria-label="Perintah pemeriksaan" spellCheck={false} style={{ minHeight: 56, fontSize: '.8rem' }} value={command} onChange={(e) => { setCommand(e.target.value); setResult(null); }} />
      <div className="row">
        <input type="number" step="any" className="input-sm" placeholder="warn" aria-label="Ambang peringatan" value={w} onChange={(e) => setW(e.target.value)} />
        <input type="number" step="any" className="input-sm" placeholder="kritis" aria-label="Ambang kritis" value={c} onChange={(e) => setC(e.target.value)} />
        <Button icon={IconBolt} disabled={!command.trim()} onClick={() => run.mutateAsync()}>Coba</Button>
        <Button primary icon={IconCheck} disabled={!command.trim() || !result || result.evaluation.status === 'unknown'} title={!result ? 'Coba perintahnya dulu' : result.evaluation.status === 'unknown' ? 'Perintah belum menghasilkan angka' : undefined} onClick={() => onSave(command.trim(), w, c)}>{saveLabel}</Button>
        {alt && <Button icon={IconScale} disabled={!command.trim() || !result || result.evaluation.status === 'unknown'} title="Simpan sebagai standar: berlaku untuk semua server yang punya layanan ini" onClick={() => alt.onSave(command.trim(), w, c)}>{alt.label}</Button>}
      </div>
      {result && (
        <div className="try-result" aria-live="polite">
          <p className="lbl"><Badge tone={tone}>{label}</Badge> exit {result.exitCode} | {result.ms} ms{result.evaluation.value !== null ? ` | nilai terbaca: ${result.evaluation.value}` : ''}{result.evaluation.detail ? ` | ${result.evaluation.detail}` : ''}</p>
          <pre className="out mono" style={{ maxHeight: 140, overflow: 'auto', fontSize: '.75rem' }}>{result.stdout || result.stderr || '(tanpa keluaran)'}</pre>
          {result.evaluation.status === 'unknown' && <p className="lbl">Simpan terkunci sampai perintah menghasilkan angka pada keluarannya. Ubah perintahnya lalu Coba lagi.</p>}
        </div>
      )}
    </div>
  );
}

function Suggestions({ serverId, units, onSaved }: { serverId: number; units: string[]; onSaved: () => void }) {
  const [list, setList] = useState<{ suggestions: Suggestion[]; model: string } | null>(null);
  const ask = useAction(() => post<{ suggestions: Suggestion[]; model: string }>(`/api/servers/${serverId}/checks/suggest`, { units }), { onSuccess: setList });
  const add = useAction((s: { title: string; command: string; warn: string; crit: string }) => post(`/api/servers/${serverId}/checks`, { name: s.title, type: 'custom', params: { command: s.command }, warn: s.warn === '' ? null : Number(s.warn), crit: s.crit === '' ? null : Number(s.crit), confirm: 2, pack: 'lain' }), {
    success: 'Pemeriksaan ditambahkan', invalidate: [['servers', serverId, 'monitor']], onSuccess: onSaved
  });
  const addStd = useAction((s: { unit: string; title: string; command: string; warn: string; crit: string }) => post('/api/standards/packs', { unit: s.unit, serverId, checks: [customCheck(s.unit, s.title, s.command, s.warn, s.crit)] }), {
    success: 'Disimpan ke standar dan dipasang di server ini', invalidate: [['servers', serverId, 'monitor'], ['standards']], onSuccess: onSaved
  });
  return (
    <div>
      <div className="row"><Button icon={IconSpark} onClick={() => ask.mutateAsync()}>Minta saran AI{units.length ? ` untuk ${units.length} layanan terpilih` : ' untuk layanan tanpa paket'}</Button></div>
      {list && (
        <>
          <p className="lbl" style={{ margin: '8px 0' }}>Ditulis AI ({list.model}). Ini tebakan: perintahnya bisa salah di server Anda. Coba dulu, ubah bila perlu, baru simpan. Tidak ada yang tersimpan otomatis.</p>
          {list.suggestions.length === 0 && <Note>AI tidak punya usulan.</Note>}
          {list.suggestions.map((s) => (
            <div key={s.unit} className="panel" style={{ marginBottom: 8 }}>
              <b>{s.unit}</b>: {s.title}{s.why && <span className="lbl"> | {s.why}</span>}
              {!s.readOnly ? <Hint icon={IconInfo}><span>{s.problem}</span></Hint>
                : <CommandTester serverId={serverId} initial={s.command} saveLabel="Simpan" onSave={(command, warn, crit) => add.mutateAsync({ title: s.title, command, warn, crit })} alt={{ label: 'Simpan ke standar', onSave: (command, warn, crit) => addStd.mutateAsync({ unit: s.unit, title: s.title, command, warn, crit }) }} />}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** Menyimpan layanan yang belum ada di Standar: hidup atau mati, ditambah pemeriksaan perintah baca-saja bila perlu. Berlaku untuk semua server yang punya unit ini. */
function AddToStandard({ serverId, unit, onBack, onDone }: { serverId: number; unit: string; onBack: () => void; onDone: () => void }) {
  const [label, setLabel] = useState(unit), [onoff, setOnoff] = useState(true), [extra, setExtra] = useState<StdCheck[]>([]), [title, setTitle] = useState('');
  const checks = [...(onoff ? [{ name: `${unit}: layanan aktif`, type: 'systemd', params: { unit }, confirm: 2 } as StdCheck] : []), ...extra];
  const save = useAction(() => post('/api/standards/packs', { unit, label: label.trim() || unit, serverId, checks }), {
    success: 'Disimpan ke standar dan dipasang di server ini', invalidate: [['servers', serverId, 'monitor'], ['standards']], onSuccess: onDone
  });
  return (
    <div className="form" aria-label="Tambahkan ke standar">
      <h2><IconScale size={16} aria-hidden />Tambahkan {unit} ke standar</h2>
      <p className="lbl">Layanan ini belum ada di Standar pemantauan. Setelah disimpan, ia tercatat di database aplikasi: terpasang di server ini, dikenali di server lain yang punya unit {unit}, dan ambangnya diatur di halaman Standar.</p>
      <label className="field"><span>Nama layanan</span><input aria-label="Nama layanan" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <label className="checkline"><input type="checkbox" checked={onoff} onChange={(e) => setOnoff(e.target.checked)} /><span>Pantau hidup atau mati (systemd)</span></label>
      <h3>Pemeriksaan tambahan (opsional)</h3>
      <input aria-label="Judul pemeriksaan" placeholder="judul, mis. jumlah antrean" value={title} onChange={(e) => setTitle(e.target.value)} />
      <CommandTester serverId={serverId} initial="" saveLabel="Tambahkan ke daftar" onSave={async (command, warn, crit) => { setExtra((x) => [...x, customCheck(unit, title.trim() || `pemeriksaan ${x.length + 1}`, command, warn, crit)]); setTitle(''); }} />
      {extra.length > 0 && <ul className="plain">{extra.map((c) => <li key={c.name}><span className="mono">{c.name}</span> <Button icon={IconClose} aria-label={`Buang ${c.name}`} onClick={() => setExtra((x) => x.filter((y) => y !== c))} /></li>)}</ul>}
      <div className="row"><Button primary icon={IconCheck} disabled={!checks.length} onClick={() => save.mutateAsync()}>Simpan ke standar dan pasang di server ini ({checks.length})</Button><Button icon={IconClose} onClick={onBack}>Kembali</Button></div>
    </div>
  );
}

export function ServicesPanel({ serverId, existing, onClose }: { serverId: number; existing: string[]; onClose: () => void }) {
  const scan = useQuery({ queryKey: ['servers', serverId, 'scan'], queryFn: () => get<ScanResult>(`/api/servers/${serverId}/scan`), staleTime: 0, retry: false });
  const [picked, setPicked] = useState<Set<string>>(new Set()), [q, setQ] = useState(''), [system, setSystem] = useState(false), [adding, setAdding] = useState<string | null>(null);
  const have = new Set(existing);
  const addActive = useAction(async () => { for (const unit of picked) await post(`/api/servers/${serverId}/checks`, { name: activeCheckName(unit), type: 'systemd', params: { unit }, confirm: 2, pack: 'lain' }); }, {
    success: 'Pemeriksaan ditambahkan', invalidate: [['servers', serverId, 'monitor']], onSuccess: onClose
  });
  const toggle = (u: string) => setPicked((p) => { const n = new Set(p); if (n.has(u)) n.delete(u); else n.add(u); return n; });
  if (adding) return <AddToStandard serverId={serverId} unit={adding} onBack={() => setAdding(null)} onDone={onClose} />;
  return (
    <div className="form" aria-label="Layanan di server">
      <h2><IconEye size={16} aria-hidden />Layanan yang berjalan di server</h2>
      <p className="lbl">Daftar ini dibaca langsung dari server (systemd), bukan dari daftar bawaan aplikasi. Centang yang ingin dipantau hidup atau matinya.</p>
      <Async query={scan}>{(d) => {
        const rows = d.services.filter((s) => (system || !s.noise) && s.unit.toLowerCase().includes(q.toLowerCase()));
        const unknown = d.services.filter((s) => !s.pack && !s.noise).length;
        return (
          <>
            <div className="row">
              <input aria-label="Cari layanan" placeholder="cari layanan" value={q} onChange={(e) => setQ(e.target.value)} />
              <label className="checkline"><input type="checkbox" checked={system} onChange={(e) => setSystem(e.target.checked)} /><span>tampilkan layanan sistem</span></label>
              <span className="lbl">{d.services.length} layanan berjalan | port: {d.ports.slice(0, 12).join(', ') || '-'}</span>
            </div>
            <ul className="plain" style={{ maxHeight: 280, overflow: 'auto', margin: '8px 0' }}>
              {rows.map((s) => (
                <li key={s.unit} style={{ padding: '3px 0' }}>
                  <label className="checkline">
                    <input type="checkbox" aria-label={`Pantau ${s.unit}`} checked={picked.has(s.unit)} disabled={have.has(activeCheckName(s.unit))} onChange={() => toggle(s.unit)} />
                    <span className="mono">{s.unit}</span>
                  </label>
                  {have.has(activeCheckName(s.unit)) && <Badge tone="ok">sudah dipantau</Badge>}{s.pack && <Badge tone="acc">paket {s.pack}</Badge>}{!s.pack && !s.noise && <> <Badge tone="warn">belum ada di standar</Badge> <Button icon={IconScale} onClick={() => setAdding(s.unit)}>Tambahkan ke standar</Button></>}
                </li>
              ))}
              {!rows.length && <li className="lbl">Tidak ada yang cocok.</li>}
            </ul>
            <div className="row"><Button primary icon={IconCheck} disabled={!picked.size} onClick={() => addActive.mutateAsync()}>Pantau {picked.size || ''} layanan terpilih (hidup atau mati)</Button><Button icon={IconClose} onClick={onClose}>Tutup</Button></div>
            {unknown > 0 && <div style={{ marginTop: 14 }}><h3>Pemeriksaan lebih dalam (opsional)</h3><Suggestions serverId={serverId} units={[...picked]} onSaved={onClose} /></div>}
          </>
        );
      }}</Async>
    </div>
  );
}

/** Mengubah perintah pemeriksaan kustom yang sudah tersimpan, dengan Coba. */
export function EditCommand({ serverId, checkId, params, warn, crit, onDone }: { serverId: number; checkId: number; params: Record<string, unknown>; warn: number | null; crit: number | null; onDone: () => void }) {
  const save = useAction((v: { command: string; warn: string; crit: string }) => put(`/api/checks/${checkId}`, { params: { ...params, command: v.command }, warn: v.warn === '' ? null : Number(v.warn), crit: v.crit === '' ? null : Number(v.crit) }), { success: 'Perintah diperbarui', invalidate: [['servers', serverId, 'monitor']], onSuccess: onDone });
  return (
    <div className="form">
      <h2>Ubah perintah</h2>
      <CommandTester serverId={serverId} initial={String(params.command ?? '')} warn={warn == null ? '' : String(warn)} crit={crit == null ? '' : String(crit)} saveLabel="Simpan perubahan" onSave={(command, w, c) => save.mutateAsync({ command, warn: w, crit: c })} />
      <div className="row"><Button icon={IconClose} onClick={onDone}>Batal</Button></div>
    </div>
  );
}

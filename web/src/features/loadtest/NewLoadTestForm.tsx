// Formulir uji beban baru: target, skenario request, tahap pengguna, kriteria lulus, metrik server uji, header.
import { useState } from 'react';
import { useAction } from '@/api/queries';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Hint, Note } from '@/components/ui/Layout';
import { IconAlert, IconCheck, IconClose, IconPlus, IconTrash } from '@/components/icons';
import { post } from '@/lib/api';
import { PRESET_LABELS, buildPayload, initialForm, peakVus, problems, stagePreset, totalSeconds, type FormState, type PresetKind } from './form';
import type { LoadTest, LoadTestStatus, Method } from './types';

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'DELETE'];
const patchAt = <T,>(list: T[], i: number, patch: Partial<T>): T[] => list.map((x, j) => (j === i ? { ...x, ...patch } : x));
const dropAt = <T,>(list: T[], i: number): T[] => list.filter((_, j) => j !== i);

export function NewLoadTestForm({ status, onCreated, onCancel, prefill }: { status: LoadTestStatus | undefined; onCreated: (id: number) => void; onCancel: () => void; prefill?: { target?: string; name?: string; playgroundId?: number } }) {
  const [f, setF] = useState<FormState>(() => ({ ...initialForm(), ...(prefill?.target ? { target: prefill.target } : {}), ...(prefill?.name ? { name: `Playground: ${prefill.name}` } : {}), ...(prefill?.playgroundId ? { playgroundId: prefill.playgroundId } : {}) })), set = (patch: Partial<FormState>) => setF((x) => ({ ...x, ...patch }));
  const issues = problems(f);
  const create = useAction(() => post<LoadTest>('/api/loadtests', buildPayload(f)), { success: 'Uji dibuat sebagai draf. Periksa lalu setujui untuk menjalankan.', invalidate: [['loadtests']], onSuccess: (t) => onCreated(t.id) });
  return (
    <form className="form panel" onSubmit={(e) => { e.preventDefault(); create.mutate(); }} aria-label="Uji beban baru">
      <h2><IconPlus size={16} aria-hidden />Uji beban baru</h2>

      <div className="cols tight">
        <Field label="Nama uji"><input required maxLength={80} placeholder="mis. Proyek A, 1 server aplikasi" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Target (alamat dasar server uji)" hint={status ? `Hanya jaringan lokal (10.x, 172.16-31.x, 192.168.x, localhost, nama layanan Docker)${status.allowedHosts.length ? ` atau: ${status.allowedHosts.join(', ')}` : ''}.` : undefined}>
          <input required className="mono" placeholder="http://10.0.0.5:8080" aria-label="Target" value={f.target} onChange={(e) => set({ target: e.target.value })} />
        </Field>
      </div>

      <h3>Skenario request</h3>
      <Note>Tiap "pengguna" memilih satu request secara acak menurut bobot, lalu jeda (seperti manusia). Isi dari access log: persentase tiap endpoint.</Note>
      {f.requests.map((r, i) => (
        <div className="row" key={i}>
          <select aria-label="Metode" value={r.method} onChange={(e) => set({ requests: patchAt(f.requests, i, { method: e.target.value as Method }) })}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select>
          <input className="mono" style={{ flex: '1 1 160px' }} placeholder="/produk" aria-label="Path" value={r.path} onChange={(e) => set({ requests: patchAt(f.requests, i, { path: e.target.value }) })} />
          <input type="number" min={1} max={100} style={{ width: 80 }} aria-label="Bobot" title="Bobot (persentase relatif)" value={r.weight} onChange={(e) => set({ requests: patchAt(f.requests, i, { weight: Math.max(1, Number(e.target.value) || 1) }) })} />
          {r.method !== 'GET' && <input className="mono" style={{ flex: '1 1 160px' }} placeholder='badan JSON, mis. {"id":1}' aria-label="Badan" value={r.body ?? ''} onChange={(e) => set({ requests: patchAt(f.requests, i, { body: e.target.value }) })} />}
          <Button icon={IconTrash} aria-label="Hapus request" disabled={f.requests.length === 1} onClick={() => set({ requests: dropAt(f.requests, i) })} />
        </div>
      ))}
      <div className="row">
        <Button icon={IconPlus} onClick={() => set({ requests: [...f.requests, { name: '', method: 'GET', path: '/', weight: 1 }] })}>Tambah request</Button>
        <label className="checkline"><span>Jeda antar aksi (detik)</span><input type="number" min={0} max={30} step={0.5} className="input-md" aria-label="Jeda" value={f.thinkSeconds} onChange={(e) => set({ thinkSeconds: Math.max(0, Number(e.target.value) || 0) })} /></label>
      </div>

      <h3>Tahap beban</h3>
      <div className="chips" role="group" aria-label="Preset tahap">{(Object.keys(PRESET_LABELS) as PresetKind[]).map((k) => <button key={k} type="button" onClick={() => set({ stages: stagePreset(k) })}>{PRESET_LABELS[k]}</button>)}</div>
      {f.stages.map((s, i) => (
        <div className="row" key={i}>
          <span className="lbl" style={{ width: 60 }}>Tahap {i + 1}</span>
          <input type="number" min={1} max={2000} style={{ width: 100 }} aria-label={`Pengguna tahap ${i + 1}`} value={s.vus} onChange={(e) => set({ stages: patchAt(f.stages, i, { vus: Math.max(1, Number(e.target.value) || 1) }) })} /><span className="lbl">pengguna</span>
          <input type="number" min={5} max={600} style={{ width: 100 }} aria-label={`Detik tahap ${i + 1}`} value={s.seconds} onChange={(e) => set({ stages: patchAt(f.stages, i, { seconds: Math.max(5, Number(e.target.value) || 5) }) })} /><span className="lbl">detik</span>
          <Button icon={IconTrash} aria-label={`Hapus tahap ${i + 1}`} disabled={f.stages.length === 1} onClick={() => set({ stages: dropAt(f.stages, i) })} />
        </div>
      ))}
      <div className="row">
        <Button icon={IconPlus} disabled={f.stages.length >= 12} onClick={() => set({ stages: [...f.stages, { vus: Math.round(peakVus(f.stages) * 2) || 10, seconds: 30 }] })}>Tambah tahap</Button>
        <span className="lbl">Total {totalSeconds(f.stages)} detik, puncak {peakVus(f.stages)} pengguna</span>
      </div>

      <h3>Kriteria lulus</h3>
      <div className="cols tight">
        <Field label="p95 maksimal (ms)"><input type="number" min={10} max={60000} value={f.criteria.p95Ms} onChange={(e) => set({ criteria: { ...f.criteria, p95Ms: Number(e.target.value) || 1000 } })} /></Field>
        <Field label="Error maksimal (%)"><input type="number" min={0} max={100} step={0.5} value={f.criteria.errPct} onChange={(e) => set({ criteria: { ...f.criteria, errPct: Number(e.target.value) || 0 } })} /></Field>
      </div>

      <details>
        <summary>Metrik server uji (opsional, sangat disarankan)</summary>
        <div className="body">
          <Note>Aplikasi membaca metrik ini tiap detik selama tiap tahap, supaya kelihatan komponen mana yang naik saat beban naik. Format: teks Prometheus (node_exporter, postgres_exporter, redis_exporter, ...) atau JSON; isi nama metrik atau jalur kunci JSON.</Note>
          {f.scrape.map((s, i) => (
            <div className="row" key={i}>
              <input placeholder="label" aria-label="Label metrik" style={{ width: 130 }} value={s.label} onChange={(e) => set({ scrape: patchAt(f.scrape, i, { label: e.target.value }) })} />
              <input className="mono" placeholder="http://10.0.0.5:9100/metrics" aria-label="Alamat metrik" style={{ flex: '1 1 200px' }} value={s.url} onChange={(e) => set({ scrape: patchAt(f.scrape, i, { url: e.target.value }) })} />
              <input className="mono" placeholder="node_load1" aria-label="Nama metrik" style={{ width: 170 }} value={s.metric} onChange={(e) => set({ scrape: patchAt(f.scrape, i, { metric: e.target.value }) })} />
              <Button icon={IconTrash} aria-label="Hapus metrik" onClick={() => set({ scrape: dropAt(f.scrape, i) })} />
            </div>
          ))}
          <div><Button icon={IconPlus} disabled={f.scrape.length >= 6} onClick={() => set({ scrape: [...f.scrape, { label: '', url: '', metric: '' }] })}>Tambah metrik</Button></div>
        </div>
      </details>

      <details>
        <summary>Header ke target (opsional, mis. Authorization untuk staging)</summary>
        <div className="body">
          <Note>Disimpan terenkripsi dan tidak pernah ditampilkan kembali. Pakai kredensial khusus staging, jangan kredensial produksi.</Note>
          {f.headers.map((h, i) => (
            <div className="row" key={i}>
              <input className="mono" placeholder="Authorization" aria-label="Nama header" style={{ width: 180 }} value={h.key} onChange={(e) => set({ headers: patchAt(f.headers, i, { key: e.target.value }) })} />
              <input className="mono" type="password" autoComplete="off" placeholder="nilai" aria-label="Nilai header" style={{ flex: '1 1 200px' }} value={h.value} onChange={(e) => set({ headers: patchAt(f.headers, i, { value: e.target.value }) })} />
              <Button icon={IconTrash} aria-label="Hapus header" onClick={() => set({ headers: dropAt(f.headers, i) })} />
            </div>
          ))}
          <div><Button icon={IconPlus} disabled={f.headers.length >= 10} onClick={() => set({ headers: [...f.headers, { key: '', value: '' }] })}>Tambah header</Button></div>
        </div>
      </details>

      <Hint icon={IconAlert}>
        <label className="checkline" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={f.confirm} onChange={(e) => set({ confirm: e.target.checked })} />
          <span><b>Saya memastikan target ini BUKAN server produksi</b> dan bukan layanan milik orang lain. Uji beban yang salah sasaran bisa menjatuhkan layanan.</span>
        </label>
      </Hint>

      {issues.length > 0 && f.name && <Note>{issues.join('. ')}.</Note>}
      <div className="row">
        <button type="submit" className="primary" disabled={issues.length > 0 || create.isPending}><IconCheck size={16} aria-hidden />Simpan sebagai draf</button>
        <Button icon={IconClose} onClick={onCancel}>Batal</Button>
      </div>
    </form>
  );
}

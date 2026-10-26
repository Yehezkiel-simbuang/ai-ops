// Formulir uji beban baru dalam tata letak penyusun: langkah bernomor di kiri, ringkasan "yang akan diuji" dan pratinjau arsitektur di kanan.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAction } from '@/api/queries';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Hint, Note } from '@/components/ui/Layout';
import { Step } from '@/components/ui/Step';
import { IconAlert, IconCheck, IconClose, IconInfo, IconPlus, IconTrash } from '@/components/icons';
import { post } from '@/lib/api';
import { ArchitectureDiagram, Legend } from './ArchitectureView';
import { PRESET_LABELS, buildPayload, initialForm, peakVus, problems, stagePreset, totalSeconds, type FormState, type PresetKind } from './form';
import { loadQ } from './queries';
import type { LoadTest, LoadTestStatus, Method } from './types';

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'DELETE'];
const patchAt = <T,>(list: T[], i: number, patch: Partial<T>): T[] => list.map((x, j) => (j === i ? { ...x, ...patch } : x));
const dropAt = <T,>(list: T[], i: number): T[] => list.filter((_, j) => j !== i);
const minutes = (s: number): string => (s >= 120 ? `${Math.round(s / 60)} menit` : `${s} detik`);

/** Pratinjau susunan Playground yang diuji: komponennya dan apa yang akan dicatat. */
function SetupPreview({ pg }: { pg: number }) {
  const q = useQuery(loadQ.preview(pg));
  if (!q.data) return q.isLoading ? <p className="lbl">Memuat susunan...</p> : null;
  const a = q.data.architecture;
  return (
    <div className="stack" aria-label="Susunan yang diuji">
      <p className="lbl" style={{ margin: 0 }}>Susunan Playground <b>{q.data.setup.name}</b>: {a.nodes.length} komponen di satu server uji.</p>
      <ArchitectureDiagram boxes={a.current} edges={a.edges} label="Susunan yang akan diuji" />
      <Legend />
      <p className="lbl" style={{ margin: 0 }}>Selama uji, pemakaian CPU dan memori tiap komponen dicatat, supaya hasilnya bisa menunjuk komponen mana yang jenuh dan menyarankan penempatannya.</p>
    </div>
  );
}

export function NewLoadTestForm({ status, onCreated, onCancel, prefill }: { status: LoadTestStatus | undefined; onCreated: (id: number) => void; onCancel: () => void; prefill?: { target?: string; name?: string; playgroundId?: number } }) {
  const [f, setF] = useState<FormState>(() => ({ ...initialForm(), ...(prefill?.target ? { target: prefill.target } : {}), ...(prefill?.name ? { name: `Playground: ${prefill.name}` } : {}), ...(prefill?.playgroundId ? { playgroundId: prefill.playgroundId } : {}) })), set = (patch: Partial<FormState>) => setF((x) => ({ ...x, ...patch }));
  const issues = problems(f);
  const create = useAction(() => post<LoadTest>('/api/loadtests', buildPayload(f)), { success: 'Uji dibuat sebagai draf. Periksa lalu setujui untuk menjalankan.', invalidate: [['loadtests']], onSuccess: (t) => onCreated(t.id) });
  const peak = peakVus(f.stages), total = totalSeconds(f.stages), weights = f.requests.reduce((s, r) => s + r.weight, 0);
  return (
    <form className="pg-layout" onSubmit={(e) => { e.preventDefault(); create.mutate(); }} aria-label="Uji beban baru">
      <div className="pg-main panel">
        <Step n={1} title="Apa yang diuji" hint="Alamat server uji dan request yang dikirim pengguna tiruan. Tiap pengguna memilih satu request secara acak menurut bobot, lalu jeda seperti manusia.">
          <div className="cols tight">
            <Field label="Nama uji"><input required maxLength={80} placeholder="mis. Proyek A, 1 server aplikasi" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Target (alamat dasar server uji)" hint={status ? `Hanya jaringan lokal (10.x, 172.16-31.x, 192.168.x, localhost, nama layanan Docker)${status.allowedHosts.length ? ` atau: ${status.allowedHosts.join(', ')}` : ''}.` : undefined}>
              <input required className="mono" placeholder="http://10.0.0.5:8080" aria-label="Target" value={f.target} onChange={(e) => set({ target: e.target.value })} />
            </Field>
          </div>
          <h3>Skenario request</h3>
          <Note>Isi dari access log: persentase tiap endpoint.</Note>
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
        </Step>

        <Step n={2} title="Seberapa berat" hint="Beban dinaikkan bertahap. Hasil tiap tahap menunjukkan di mana sistem mulai tidak sehat (lutut).">
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
            <Button icon={IconPlus} disabled={f.stages.length >= 12} onClick={() => set({ stages: [...f.stages, { vus: Math.round(peak * 2) || 10, seconds: 30 }] })}>Tambah tahap</Button>
            <span className="lbl">Total {total} detik, puncak {peak} pengguna</span>
          </div>
        </Step>

        <Step n={3} title="Kapan dianggap sehat" hint="Tahap pertama yang melanggar salah satu batas ini ditandai sebagai lutut.">
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
        </Step>
      </div>

      <aside className="pg-aside panel" aria-label="Ringkasan">
        <h2>Yang akan diuji</h2>
        <dl className="lt-summary">
          <dt>Nama</dt><dd>{f.name.trim() || <span className="lbl">belum diisi</span>}</dd>
          <dt>Target</dt><dd className="mono">{f.target.trim() || <span className="lbl">belum diisi</span>}</dd>
          <dt>Skenario</dt><dd>{f.requests.length} request{weights ? `, bobot total ${weights}` : ''}</dd>
          <dt>Beban</dt><dd>{f.stages.length} tahap, puncak {peak} pengguna, {minutes(total)}</dd>
          <dt>Sehat bila</dt><dd>p95 sampai {f.criteria.p95Ms} ms dan error sampai {f.criteria.errPct}%</dd>
        </dl>
        {f.playgroundId
          ? <SetupPreview pg={f.playgroundId} />
          : <Hint icon={IconInfo}><span>Tanpa susunan Playground, analisis hanya dari kurva hasil. Untuk menunjuk <b>komponen yang jenuh</b> dan menyarankan penempatannya, jalankan dari susunan yang sedang berjalan di Playground (tombol Uji beban).</span></Hint>}
        <div className="pg-next">
          <b>Setelah disimpan</b>
          <ol className="lbl"><li>Tersimpan sebagai <b>draf</b>; belum ada beban yang dikirim.</li><li>Anda memeriksa lalu <b>menyetujui</b>. Runner menaikkan beban tahap demi tahap.</li><li>Hasil berisi kurva, <b>di mana bottleneck-nya</b>, dan <b>saran arsitektur</b>.</li></ol>
        </div>
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
      </aside>
    </form>
  );
}

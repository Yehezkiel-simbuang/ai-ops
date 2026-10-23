// Pengaturan beban: jumlah pengguna x request per menit, lonjakan, durasi, dan gangguan.
import { Field } from '@/components/ui/Field';
import { Hint } from '@/components/ui/Layout';
import { IconAlert } from '@/components/icons';
import { MAX_PEAK_RPS, peakRps, totalRps } from './scenario';
import type { LabFailure, LabLoad, LabProject, Scenario } from './types';

const DURATIONS = [60, 120, 180, 300];
const MULTIPLIERS = [1, 3, 10];
const rpsText = (v: number) => (v >= 100 ? Math.round(v) : v.toFixed(1));

const FAILABLE = ['pool', 'db', 'cache', 'external', 'disk'];

/** Skenario kegagalan: matikan satu komponen di tengah beban dan lihat apakah layanan bertahan. */
function FailureControl({ project, failure, seconds, onChange }: { project: LabProject; failure: LabFailure | null; seconds: number; onChange: (f: LabFailure | null) => void }) {
  const targets = project.arch.nodes.filter((n) => FAILABLE.includes(n.type));
  if (!targets.length) return null;
  const first = targets.find((n) => n.type === 'db') ?? targets[0]!;
  const set = (patch: Partial<LabFailure>) => onChange({ ...(failure ?? { node: first.id, at: 30, len: 40 }), ...patch });
  return (
    <div className="stack">
      <label className="checkline"><input type="checkbox" checked={failure !== null} onChange={(e) => onChange(e.target.checked ? { node: first.id, at: Math.min(30, seconds - 20), len: 40 } : null)} /><span>Skenario kegagalan: matikan satu komponen</span></label>
      {failure && (
        <>
          <div className="cols tight">
            <Field label="Komponen yang mati"><select aria-label="Komponen yang mati" value={failure.node} onChange={(e) => set({ node: e.target.value })}>{targets.map((n) => <option key={n.id} value={n.id}>{n.label ?? n.id}</option>)}</select></Field>
            <Field label="Mulai (detik)"><input type="number" min={0} max={299} value={failure.at} onChange={(e) => set({ at: Math.max(0, Number(e.target.value) || 0) })} /></Field>
            <Field label="Lama (detik, 0 = sampai akhir)"><input type="number" min={0} max={300} value={failure.len} onChange={(e) => set({ len: Math.max(0, Number(e.target.value) || 0) })} /></Field>
          </div>
          <div className="lab-note">Tanpa cadangan, komponen itu mati total. Dengan load balancer (aplikasi) atau Database HA, hanya sebagian yang terganggu atau terganggu selama failover.</div>
        </>
      )}
    </div>
  );
}

interface Props { scenario: Scenario; project: LabProject; onLoad: (l: LabLoad) => void; onSeconds: (s: number) => void; onFaults: (on: boolean) => void; onFailure: (f: LabFailure | null) => void }

export function LoadPanel({ scenario, project, onLoad, onSeconds, onFaults, onFailure }: Props) {
  const l = scenario.load, base = project.load, over = peakRps(l) > MAX_PEAK_RPS;
  const set = (patch: Partial<LabLoad>) => onLoad({ ...l, ...patch });
  const setSpike = (patch: Partial<LabLoad['spike']>) => onLoad({ ...l, spike: { ...l.spike, ...patch } });
  return (
    <div className="stack">
      <div className="cols tight">
        <Field label="Pengguna aktif"><input type="number" min={1} max={200000} value={l.users} onChange={(e) => set({ users: Math.max(1, Number(e.target.value) || 1) })} /></Field>
        <Field label="Request / menit / pengguna"><input type="number" min={0.1} max={600} step={0.5} value={l.rpu} onChange={(e) => set({ rpu: Math.max(0.1, Number(e.target.value) || 0.1) })} /></Field>
      </div>
      <div className="row" role="group" aria-label="Pengali beban">
        <span className="lbl">Beban sekarang × </span>
        {MULTIPLIERS.map((m) => <button key={m} type="button" aria-pressed={Math.abs(l.users - base.users * m) < 1} onClick={() => set({ users: Math.max(1, Math.round(base.users * m)), rpu: base.rpu })}>{m}x</button>)}
      </div>
      <div className="lab-note">Total ≈ <b className="mono">{rpsText(totalRps(l))}</b> request/detik{l.spike.on ? <>, puncak <b className="mono">{rpsText(peakRps(l))}</b></> : null}.</div>
      {over && <Hint icon={IconAlert}>Puncak melebihi batas simulasi ({MAX_PEAK_RPS} request/detik). Kurangi pengguna atau pengali lonjakan.</Hint>}

      <label className="checkline"><input type="checkbox" checked={l.spike.on} onChange={(e) => setSpike({ on: e.target.checked })} /><span>Lonjakan trafik</span></label>
      {l.spike.on && (
        <div className="cols tight">
          <Field label="Pengali"><select value={l.spike.mult} onChange={(e) => setSpike({ mult: Number(e.target.value) })}>{[2, 3, 4, 6, 8, 10].map((m) => <option key={m} value={m}>{m}x</option>)}</select></Field>
          <Field label="Mulai (detik)"><input type="number" min={0} max={300} value={l.spike.at} onChange={(e) => setSpike({ at: Number(e.target.value) })} /></Field>
          <Field label="Lama (detik)"><input type="number" min={1} max={300} value={l.spike.len} onChange={(e) => setSpike({ len: Number(e.target.value) })} /></Field>
          <Field label="Ulangi tiap (detik, 0 = sekali)"><input type="number" min={0} max={300} value={l.spike.every} onChange={(e) => setSpike({ every: Number(e.target.value) })} /></Field>
        </div>
      )}

      <Field label="Lama simulasi"><select value={scenario.seconds} onChange={(e) => onSeconds(Number(e.target.value))}>{DURATIONS.map((d) => <option key={d} value={d}>{d} detik</option>)}</select></Field>
      <FailureControl project={project} failure={scenario.failure} seconds={scenario.seconds} onChange={onFailure} />
      {project.faults.length > 0 && (
        <label className="checkline" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={scenario.faults} onChange={(e) => onFaults(e.target.checked)} />
          <span>Sertakan gangguan{project.faultsAssumed ? ' (asumsi, bukan data nyata)' : ' (tercatat nyata)'}: {project.faults.map((f) => f.name).join('; ')}. Butuh waktu simulasi cukup panjang untuk terlihat.</span>
        </label>
      )}
    </div>
  );
}

// Beban per workload: laju (request/detik) dan waktu CPU per request. Nilai awal adalah tebakan analisis; isi dengan angka nyata
// (log akses, APM, atau hasil Uji beban) supaya urutan kejenuhan memakai data Anda.
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Note } from '@/components/ui/Layout';
import { IconReset } from '@/components/icons';
import type { LabEstimate, LabLoad, LabProject, Scenario } from './types';
import { cpuEstimateOf, currentRates, userWorkloads, withCpuMs, withRate } from './workloads';

const round = (v: number): number => Math.round(v * 100) / 100;

export function WorkloadPanel({ project, scenario, onLoad, onEstimates }: { project: LabProject; scenario: Scenario; onLoad: (l: LabLoad) => void; onEstimates: (e: LabEstimate[]) => void }) {
  const all = project.arch.workloads, list = userWorkloads(all), estimates = scenario.estimates ?? [];
  const rates = currentRates(scenario.load, all), baseRates = currentRates(project.load, all);
  if (!list.length) return null;
  return (
    <div className="stack">
      <h3>Beban per workload</h3>
      <p className="lbl">Workload adalah satu jenis lalu lintas. Laju dan waktu CPU di bawah dibuat otomatis oleh analisis, bukan diukur. Ubah dengan angka yang Anda tahu.</p>
      <ul className="plain">
        {list.map((w) => {
          const rate = rates[w.id] ?? 0, rateEdited = Math.abs(rate - (baseRates[w.id] ?? 0)) > 0.005, cpuEst = cpuEstimateOf(estimates, w.id);
          return (
            <li key={w.id} style={{ margin: '10px 0' }}>
              <div className="row"><b>{w.label ?? w.id}</b></div>
              <div className="cols tight">
                <Field label={<>Laju (request/detik) {rateEdited ? <Badge tone="acc">Anda isi</Badge> : w.rateAssumed ? <Badge tone="mute">tebakan</Badge> : null}</>}>
                  <input type="number" min={0} step={0.5} value={round(rate)} aria-label={`Laju ${w.label ?? w.id}`} onChange={(e) => onLoad(withRate(scenario.load, all, w.id, Number(e.target.value) || 0))} />
                </Field>
                {typeof w.cpuMs === 'number' && w.cpuMs > 0 && (
                  <Field label={<>Waktu CPU per request (ms) {cpuEst ? <Badge tone="acc">Anda isi</Badge> : w.cpuAssumed ? <Badge tone="mute">tebakan</Badge> : null}</>}>
                    <input type="number" min={0.1} step={0.5} value={cpuEst?.value ?? w.cpuMs} aria-label={`Waktu CPU ${w.label ?? w.id}`} onChange={(e) => onEstimates(withCpuMs(estimates, w.id, Number(e.target.value) || null))} />
                  </Field>
                )}
              </div>
              {(rateEdited || cpuEst) && (
                <Button icon={IconReset} onClick={() => { onLoad(withRate(scenario.load, all, w.id, baseRates[w.id] ?? 0)); onEstimates(withCpuMs(estimates, w.id, null)); }}>Kembalikan ke tebakan</Button>
              )}
            </li>
          );
        })}
      </ul>
      <Note>Laju diubah lewat total beban dan campuran, jadi "Pengguna aktif" di tab Beban ikut berubah. Waktu CPU yang Anda isi tidak ikut divariasikan oleh analisis sensitivitas.</Note>
    </div>
  );
}

// Lab arsitektur: eksperimen "bagaimana kalau". Pilih proyek, tambah komponen (Redis, load balancer, replika, ...), ubah beban, dan lihat dampaknya
// pada diagram yang bergerak dibanding kondisi sekarang. Awal eksperimen = rekomendasi dari analisis proyek.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { Async } from '@/components/ui/Async';
import { Button } from '@/components/ui/Button';
import { Empty, Hint, Loading, Note, PageHead, Section, Tabs } from '@/components/ui/Layout';
import { IconAlert, IconCheck, IconFlask, IconInfo, IconReset } from '@/components/icons';
import { useDebounced } from '@/lib/useDebounced';
import { BottleneckPanel, analysisKey, ranksOf } from './BottleneckPanel';
import { ComparePanel } from './ComparePanel';
import { Designs } from './Designs';
import { EstimatePanel } from './EstimatePanel';
import { AppliedActions, Recommendations } from './Experiment';
import { LoadPanel } from './LoadPanel';
import { Palette } from './Palette';
import { Playbar, Timeline, usePlayback } from './Playback';
import { Stage, fmtRate } from './Stage';
import { labQ } from './queries';
import { scenarioReducer } from './scenario';
import type { LabBottlenecks, LabFrame, LabProject, LabRun, Scenario } from './types';

type View = 'exp' | 'base' | 'split';
type SideTab = 'komponen' | 'beban' | 'rekomendasi' | 'asumsi' | 'skenario';
const STORAGE_KEY = 'aiops.lab.project', DEFAULT_PROJECT = 'contoh-toko-online';

const readStored = (): string => { try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_PROJECT; } catch { return DEFAULT_PROJECT; } };
const store = (id: string): void => { try { localStorage.setItem(STORAGE_KEY, id); } catch { /* penyimpanan tidak tersedia: abaikan */ } };

function ViewPane({ title, run, frame, newIds, ranks, busy }: { title: string; run: LabRun; frame: LabFrame | undefined; newIds?: ReadonlySet<string>; ranks?: Record<string, number>; busy: boolean }) {
  const diag = frame ? run.diags[frame.diag] : undefined;
  return (
    <div className="lab-view">
      <header><b>{title}</b>{run.failure && !run.failure.skipped && <span className="badge bad"><IconAlert size={12} aria-hidden />{run.failure.label} mati detik {run.failure.at}{run.failure.len ? `-${run.failure.at + run.failure.len}` : ' sampai akhir'}</span>}{run.failure?.skipped && <span className="badge mute">{run.failure.skipped}</span>}{busy && <span className="lbl">menghitung...</span>}</header>
      <Stage run={run} frame={frame} newIds={newIds} ranks={ranks} title={title} />
      <div className="hud" aria-label={`Kondisi ${title}`}>
        <div><b>{frame ? fmtRate(frame.offered) : '-'}</b><span>beban masuk</span></div>
        <div><b>{frame ? fmtRate(frame.ok) : '-'}</b><span>berhasil</span></div>
        <div><b>{frame ? frame.e504.toFixed(1) : '-'}</b><span>504 /dtk</span></div>
        <div><b>{frame ? `${frame.p95.toFixed(2)}s` : '-'}</b><span>p95</span></div>
      </div>
      {diag && <div className={`diag lv${diag.lv}`}>{diag.lv === 0 ? <IconCheck size={16} aria-hidden /> : <IconAlert size={16} aria-hidden />}<div><b>{diag.title}</b><p>{diag.text}</p></div></div>}
    </div>
  );
}

function LabBody({ project, foldersEnabled }: { project: LabProject; foldersEnabled: boolean }) {
  const [scenario, dispatch] = useReducer(scenarioReducer, null);
  const [view, setView] = useState<View>('exp'), [tab, setTab] = useState<SideTab>('komponen');
  const [analysis, setAnalysis] = useState<{ key: string; data: LabBottlenecks } | null>(null);
  useEffect(() => { dispatch({ type: 'init', project, start: 'rec' }); }, [project]);

  const ready = scenario && scenario.project === project.id ? scenario : null, settled = useDebounced(ready, 450);
  const sim = useQuery({ ...labQ.simulate(settled ?? ({} as Scenario)), enabled: !!settled, placeholderData: keepPreviousData });
  const result = sim.data, frames = result?.experiment.frames ?? [];
  const pb = usePlayback(frames.length, result);
  const newIds = useMemo(() => new Set(result ? result.experiment.arch.nodes.filter((n) => !result.baseline.arch.nodes.some((b) => b.id === n.id)).map((n) => n.id) : []), [result]);
  const busy = sim.isFetching || ready !== settled;
  const shown = analysis && ready && analysis.key === analysisKey(ready) ? analysis.data : undefined;   // penanda peringkat hanya untuk skenario yang dianalisis

  if (!ready) return <Loading />;
  const act = (e: Parameters<typeof dispatch>[0]) => dispatch(e);
  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <Button icon={IconCheck} onClick={() => act({ type: 'init', project, start: 'rec' })}>Mulai dari rekomendasi</Button>
        <Button icon={IconReset} onClick={() => act({ type: 'init', project, start: 'now' })}>Mulai dari kondisi sekarang</Button>
        <div className="grow" />
        <div role="group" aria-label="Tampilan" className="chips">
          {([['exp', 'Eksperimen'], ['base', 'Kondisi sekarang'], ['split', 'Berdampingan']] as const).map(([v, label]) => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{label}</button>)}
        </div>
      </div>
      {!foldersEnabled && project.source === 'contoh' && <Hint icon={IconInfo}><span>Ingin mencoba proyek Anda sendiri? Setel <code>PROJECTS_DIR</code> (mis. folder <code>D:/work</code>) dan <code>PROJECTS_ROOT=/projects</code> di <code>.env</code>, lalu proyek di folder itu muncul di daftar. Dibaca hanya-baca.</span></Hint>}

      <div className="lab-grid">
        <div className="lab-main">
          {sim.isError && !result && <Empty>Simulasi gagal: {(sim.error as Error).message}</Empty>}
          {result && (
            <>
              <div className={`lab-views${view === 'split' ? ' split' : ''}`}>
                {view !== 'base' && <ViewPane title="Eksperimen" run={result.experiment} frame={result.experiment.frames[pb.index]} newIds={newIds} ranks={ranksOf(shown?.experiment)} busy={busy} />}
                {view !== 'exp' && <ViewPane title="Kondisi sekarang" run={result.baseline} frame={result.baseline.frames[pb.index]} ranks={ranksOf(shown?.baseline)} busy={busy} />}
              </div>
              <div className="lab-view">
                <Playbar pb={pb} length={frames.length} time={frames[pb.index]?.t ?? 0} />
                <div style={{ padding: '4px 12px 8px' }}>
                  <Timeline base={result.baseline.frames} exp={frames} index={pb.index} onSeek={pb.seek} />
                  <div className="row lbl"><span className="key"><i style={{ background: 'var(--bad)' }} />kondisi sekarang</span><span className="key"><i style={{ background: 'var(--accent)' }} />eksperimen</span><span>waktu respons p95; klik untuk melompat</span></div>
                </div>
              </div>
              {result.baseline.summary.fastPct >= 95 && (
                <Hint icon={IconInfo}>
                  <div>Kondisi sekarang masih sehat pada beban ini, jadi perubahan belum terlihat bedanya. Coba naikkan bebannya:</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    {[3, 10].map((m) => <Button key={m} onClick={() => act({ type: 'setLoad', load: { ...ready.load, users: Math.max(1, Math.round(project.load.users * m)), rpu: project.load.rpu } })}>Beban {m}x</Button>)}
                    <Button onClick={() => act({ type: 'setLoad', load: { ...ready.load, spike: { ...ready.load.spike, on: true } } })}>Lonjakan {ready.load.spike.mult}x</Button>
                  </div>
                </Hint>
              )}
              <Section title="Hasil dibanding kondisi sekarang" icon={IconFlask}>
                <ComparePanel base={result.baseline} exp={result.experiment} hasChanges={ready.actions.length > 0} />
                {result.skipped.length > 0 && <Note>Tidak diterapkan: {result.skipped.map((s) => s.reason).join(' ')}</Note>}
              </Section>
              <Section title="Potensi bottleneck" icon={IconAlert}>
                <BottleneckPanel project={project} scenario={ready} analysis={analysis} onResult={(key, data) => setAnalysis({ key, data })} />
              </Section>
            </>
          )}
          {!result && !sim.isError && <Loading />}
        </div>

        <aside className="lab-side" aria-label="Panel eksperimen">
          <div className="panel">
            <h2>Eksperimen Anda ({ready.actions.length})</h2>
            <AppliedActions actions={ready.actions} catalog={project.catalog} recs={project.recs} onRemove={(key) => act({ type: 'removeAction', key })} onClear={() => act({ type: 'clearActions' })} />
          </div>
          <div className="panel">
            <Tabs value={tab} onChange={setTab} tabs={[{ id: 'komponen', label: 'Komponen' }, { id: 'beban', label: 'Beban' }, { id: 'rekomendasi', label: 'Rekomendasi' }, { id: 'asumsi', label: 'Asumsi' }, { id: 'skenario', label: 'Skenario' }]} />
            {tab === 'komponen' && <Palette catalog={project.catalog} actions={ready.actions} onApply={(component, params) => act({ type: 'setComponent', component, params })} onRemove={(key) => act({ type: 'removeAction', key })} />}
            {tab === 'beban' && <LoadPanel scenario={ready} project={project} onLoad={(load) => act({ type: 'setLoad', load })} onSeconds={(seconds) => act({ type: 'setSeconds', seconds })} onFaults={(on) => act({ type: 'setFaults', on })} onFailure={(failure) => act({ type: 'setFailure', failure })} />}
            {tab === 'rekomendasi' && <Recommendations recs={project.recs} actions={ready.actions} onToggle={(id) => act({ type: 'toggleRec', id })} />}
            {tab === 'asumsi' && <EstimatePanel project={project} scenario={ready} onApply={(estimates) => act({ type: 'setEstimates', estimates })} />}
            {tab === 'skenario' && <Designs scenario={ready} onLoad={(d) => act({ type: 'restore', scenario: { project: d.project, actions: d.actions, load: d.load, seconds: d.seconds, faults: d.faults, failure: d.failure ?? null } })} />}
          </div>
          <Note>Model ini menyederhanakan kenyataan (lihat "Asumsi model" di tiap komponen). Pakai untuk membandingkan pilihan, bukan memprediksi angka persis.</Note>
        </aside>
      </div>
    </>
  );
}

export function LabPage() {
  const projects = useQuery(labQ.projects()), [id, setId] = useState(readStored);
  const list = projects.data?.projects ?? [], effectiveId = list.length && !list.some((p) => p.id === id) ? list[0]!.id : id;
  const project = useQuery({ ...labQ.project(effectiveId), enabled: !!projects.data });
  const pick = (next: string) => { setId(next); store(next); };
  const examples = list.filter((p) => p.source === 'contoh'), folders = list.filter((p) => p.source === 'folder');
  return (
    <>
      <PageHead title="Arsitektur" icon={IconFlask}>
        {projects.data && (
          <select aria-label="Proyek" value={effectiveId} onChange={(e) => pick(e.target.value)} style={{ maxWidth: 360 }}>
            <optgroup label="Contoh dan studi kasus">{examples.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
            {folders.length > 0 && <optgroup label="Proyek Anda (folder)">{folders.map((p) => <option key={p.id} value={p.id}>{p.name}{p.stack.length ? ` (${p.stack.join(', ')})` : ''}</option>)}</optgroup>}
          </select>
        )}
      </PageHead>
      <Async query={projects}>{() => (project.isPending
        ? <Empty>Menganalisis proyek...</Empty>
        : project.isError ? <Empty>Gagal memuat proyek: {(project.error as Error).message}</Empty>
        : <LabBody key={project.data.id} project={project.data} foldersEnabled={projects.data?.foldersEnabled ?? false} />)}
      </Async>
    </>
  );
}

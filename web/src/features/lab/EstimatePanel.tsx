// Asumsi model: parameter yang masih tebakan, dan usulan nilai dari AI yang membaca berkas konfigurasi proyek.
// Setiap usulan membawa tingkat keyakinan dan bukti (berkas:baris). Usulan baru dipakai simulasi setelah Anda menerimanya.
import { useState } from 'react';
import { useAction } from '@/api/queries';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Note } from '@/components/ui/Layout';
import { IconCheck, IconReset, IconSpark } from '@/components/icons';
import { post } from '@/lib/api';
import type { LabEstimate, LabEstimateResult, LabProject, Scenario } from './types';

const TONE: Record<LabEstimateResult['estimates'][number]['confidence'], Tone> = { tinggi: 'ok', sedang: 'warn', rendah: 'bad' };
const idOf = (e: { node: string; key: string }): string => `${e.node}.${e.key}`;

/** Parameter yang masih tebakan pada arsitektur proyek, dikurangi yang sudah diganti estimasi. */
export function guessedParams(project: LabProject, accepted: LabEstimate[]): Array<{ node: string; key: string; value: unknown }> {
  const done = new Set(accepted.map(idOf));
  return project.arch.nodes.flatMap((n) => (n.assumed ?? []).filter((k) => !done.has(`${n.id}.${k}`)).map((k) => ({ node: n.id, key: k, value: (n as unknown as Record<string, unknown>)[k] })));
}

export function EstimatePanel({ project, scenario, onApply }: { project: LabProject; scenario: Scenario; onApply: (list: LabEstimate[]) => void }) {
  const accepted = scenario.estimates ?? [], isFolder = project.source === 'folder';
  const [result, setResult] = useState<LabEstimateResult | null>(null), [picked, setPicked] = useState<Set<string>>(new Set());
  const ask = useAction(() => post<LabEstimateResult>('/api/lab/estimate', { project: project.id }), {
    onSuccess: (r) => { setResult(r); setPicked(new Set(r.estimates.filter((e) => e.verified).map(idOf))); }
  });
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const apply = () => { if (result) onApply([...accepted.filter((a) => !picked.has(idOf(a))), ...result.estimates.filter((e) => picked.has(idOf(e))).map(({ node, key, value }) => ({ node, key, value }))]); };
  const guessed = guessedParams(project, accepted);

  return (
    <div>
      <p className="lbl">Parameter berikut belum diukur: nilainya tebakan awal dari analisis. AI dapat membaca berkas konfigurasi proyek (rahasia disamarkan) dan mengusulkan nilai berikut buktinya.</p>
      <div className="row" style={{ margin: '8px 0' }}>
        <Button icon={IconSpark} disabled={!isFolder} onClick={() => ask.mutateAsync()}>Perkirakan dengan AI</Button>
        {accepted.length > 0 && <Button icon={IconReset} onClick={() => onApply([])}>Kembalikan ke tebakan</Button>}
      </div>
      {!isFolder && <Note>Hanya untuk proyek dari folder. Contoh bawaan tidak punya kode untuk dibaca.</Note>}

      {result && (
        <>
          <div className="lbl">Ditulis AI ({result.model}) dari {result.filesRead.length} berkas. Keyakinan adalah penilaian model yang dicek server: bukti yang tidak cocok dipaksa "rendah". Bukan probabilitas terkalibrasi.</div>
          {result.estimates.length === 0 && <Note>AI tidak menemukan bukti untuk {result.assumedCount} parameter tebakan. Nilai tebakan tetap dipakai.</Note>}
          <ul className="plain">
            {result.estimates.map((e) => (
              <li key={idOf(e)} style={{ margin: '8px 0' }}>
                <label className="row">
                  <input type="checkbox" checked={picked.has(idOf(e))} onChange={() => toggle(idOf(e))} aria-label={`Pakai ${idOf(e)}`} />
                  <b>{idOf(e)}</b> <span>{String(e.current)} {'->'} {e.value}</span>
                  <Badge tone={TONE[e.confidence]}>keyakinan {e.confidence}</Badge>
                  {!e.verified && <Badge tone="warn">bukti tidak cocok</Badge>}
                </label>
                <div className="lbl">{e.verified ? <code>{e.file}:{e.line}</code> : 'tanpa bukti yang bisa dicek'} {e.reason}</div>
              </li>
            ))}
          </ul>
          {result.estimates.length > 0 && <Button primary icon={IconCheck} onClick={apply}>Pakai yang dipilih</Button>}
        </>
      )}

      {accepted.length > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>Dipakai simulasi ({accepted.length})</h3>
          <ul className="plain">{accepted.map((a) => <li key={idOf(a)}><b>{idOf(a)}</b> = {a.value} <Badge tone="acc">dari AI</Badge></li>)}</ul>
        </>
      )}
      <h3 style={{ marginTop: 14 }}>Masih tebakan ({guessed.length})</h3>
      {guessed.length === 0 ? <Note>Tidak ada parameter tebakan tersisa.</Note> : (
        <ul className="plain">{guessed.map((g) => <li key={idOf(g)}><b>{idOf(g)}</b> = {String(g.value)} <Badge tone="mute">tebakan</Badge></li>)}</ul>
      )}
    </div>
  );
}

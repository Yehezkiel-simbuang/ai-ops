// Satu rekomendasi: diagnosis, langkah (dengan kotak pilih), tombol setujui/tolak/susun ulang, dan hasil eksekusi.
import { useState } from 'react';
import { useAction } from '@/api/queries';
import type { ExecPath, RecStep, Recommendation, StepStatus } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { RecStatusBadge } from '@/components/StatusBadges';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Hint, Note } from '@/components/ui/Layout';
import { IconAlert, IconBan, IconBulb, IconCheck, IconEye, IconList, IconOk, IconRefresh, IconTimer, IconWrench, IconClose, IconBad, type IconType } from '@/components/icons';
import { post } from '@/lib/api';
import { toast } from '@/lib/toast';

export const EXEC_PATHS: Record<ExecPath, string> = { ssh: 'SSH dari aplikasi', agent: 'agen di server', none: 'tidak ada (isi kunci SSH atau aktifkan eksekusi di agen)' };
const RISK: Record<string, Tone> = { rendah: 'ok', sedang: 'warn', tinggi: 'bad' };
const STEP_STATUS: Record<StepStatus, [Tone, IconType, string]> = {
  pending: ['mute', IconTimer, 'menunggu'], running: ['acc', IconRefresh, 'berjalan'], done: ['ok', IconOk, 'selesai'], failed: ['bad', IconBad, 'gagal'],
  skipped: ['mute', IconClose, 'dilewati'], blocked: ['bad', IconBan, 'diblokir'], queued: ['acc', IconTimer, 'antre']
};
const CLASS_BADGE = { read: ['mute', IconEye, 'baca'], change: ['warn', IconWrench, 'mengubah'], blocked: ['bad', IconBan, 'diblokir'] } as const;

const canSelect = (s: RecStep) => s.class !== 'blocked' && s.status !== 'done';

function StepCard({ s, actionable, checked, onToggle }: { s: RecStep; actionable: boolean; checked: boolean; onToggle: (v: boolean) => void }) {
  const [tone, Icon, label] = STEP_STATUS[s.status] ?? STEP_STATUS.pending;
  const [cTone, CIcon, cLabel] = CLASS_BADGE[s.class];
  return (
    <div className={`card${s.class === 'change' && actionable ? ' wait' : ''}`}>
      <div className="hd">
        <input type="checkbox" checked={checked} disabled={!actionable || !canSelect(s)} aria-label={`Pilih langkah ${s.n}`} onChange={(e) => onToggle(e.target.checked)} />
        <b>{s.n}. {s.title}</b>
        <Badge tone={cTone} icon={CIcon}>{cLabel}</Badge>
        <Badge tone={RISK[s.risk] ?? 'mute'}>risiko {s.risk}</Badge>
        <div className="grow" />
        <Badge tone={tone} icon={Icon}>{label}</Badge>
      </div>
      <div className="bd">
        <pre className="cmd">{s.command}</pre>
        {s.rationale && <div className="thought">{s.rationale}</div>}
        {s.rollback && <div className="lbl">Pembatalan: {s.rollback}</div>}
        {(s.stdout || s.stderr) && (
          <details>
            <summary>Keluaran (exit {s.exit_code}, via {s.via ?? '-'})</summary>
            <pre className="out">{(s.stdout || '') + (s.stderr ? `\n[stderr]\n${s.stderr}` : '')}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

/** incident.id kosong = rencana patch (tanpa insiden): tidak ada tombol susun ulang. */
export function RecommendationView({ incident, rec, path }: { incident: { id: number | null; server_name: string }; rec: Recommendation; path: ExecPath }) {
  const { confirm } = useDialogs();
  const [selected, setSelected] = useState<Record<number, boolean>>(() => Object.fromEntries(rec.steps.map((s) => [s.n, canSelect(s)])));
  const actionable = rec.status === 'proposed' || rec.status === 'failed';
  const chosen = rec.steps.filter((s) => selected[s.n] && canSelect(s));
  const changes = chosen.filter((s) => s.class === 'change');
  const invalidate = [['incidents'], ['overview'], ['patch-plan']];

  const approve = useAction(() => post(`/api/recommendations/${rec.id}/approve`, { steps: chosen.map((s) => s.n) }), { success: 'Disetujui, dijalankan...', invalidate });
  const reject = useAction(() => post(`/api/recommendations/${rec.id}/reject`), { invalidate });
  const regenerate = useAction((useModel: boolean) => { toast('Menyusun ulang...'); return post(`/api/incidents/${incident.id}/regenerate`, { useModel }); }, { invalidate });
  const isPatch = rec.kind === 'patch' || incident.id === null;

  const doApprove = async () => {
    const what = changes.length ? ` (${changes.length} di antaranya MENGUBAH sistem)` : ' (hanya membaca)';
    const ok = await confirm(`Anda menyetujui ${chosen.length} perintah${what} dijalankan di ${incident.server_name} lewat ${EXEC_PATHS[path]}.\n\nLanjutkan?`, 'Setujui dan jalankan');
    if (ok) await approve.mutateAsync();
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}><IconBulb size={16} aria-hidden />{isPatch ? 'Rencana patch' : 'Rekomendasi'} #{rec.id}</h2>
        <RecStatusBadge status={rec.status} />
        {!isPatch && <Badge>{rec.source === 'llm' ? 'disusun model' : 'playbook'}</Badge>}
        <div className="grow" />
        <span className="lbl">Jalur eksekusi: {EXEC_PATHS[path]}</span>
      </div>
      <Hint><span style={{ whiteSpace: 'pre-line' }}>{rec.diagnosis}</span></Hint>
      <div className="tl">{rec.steps.map((s) => <StepCard key={s.id} s={s} actionable={actionable} checked={!!selected[s.n]} onToggle={(v) => setSelected((x) => ({ ...x, [s.n]: v }))} />)}</div>

      {rec.summary && (
        <div style={{ marginTop: 12 }}>
          <Hint icon={rec.status === 'done' ? IconOk : IconAlert}>
            <div>{rec.summary}</div>
            {rec.verify_out && <pre className="out" style={{ marginTop: 8 }}>Verifikasi: {rec.verify_out}</pre>}
            {rec.resolved_after && <div className="lbl">Agen melaporkan kondisi sudah pulih setelah perbaikan ini.</div>}
          </Hint>
        </div>
      )}

      {actionable && (
        <>
          <div className="row" style={{ marginTop: 14 }}>
            <Button primary icon={IconCheck} disabled={!chosen.length || path === 'none'} onClick={doApprove}>Setujui dan jalankan ({chosen.length} langkah)</Button>
            <Button icon={IconBan} onClick={() => reject.mutateAsync()}>Tolak</Button>
            {!isPatch && <Button icon={IconBulb} onClick={() => regenerate.mutateAsync(true)}>Susun ulang dengan model</Button>}
            {!isPatch && <Button icon={IconList} onClick={() => regenerate.mutateAsync(false)}>Susun ulang (playbook)</Button>}
          </div>
          {path === 'none' && <Note>Belum ada jalur eksekusi untuk server ini: tempel kunci SSH di halaman Server, atau aktifkan agen dengan eksekusi (halaman Agen) dan tunggu agen online.</Note>}
        </>
      )}
    </>
  );
}

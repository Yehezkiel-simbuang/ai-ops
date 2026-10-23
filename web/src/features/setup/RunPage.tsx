import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { q, useAction } from '@/api/queries';
import type { PlanStepStatus, Run, RunCommand, RunDetail, RunThought } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { RunStatusBadge } from '@/components/StatusBadges';
import { Async } from '@/components/ui/Async';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Charts';
import { Empty, Hint, PageHead } from '@/components/ui/Layout';
import { IconBad, IconBan, IconClose, IconEye, IconGauge, IconList, IconOk, IconPlay, IconRefresh, IconStop, IconTerminal, IconTimer, IconTrash, IconWrench, type IconType } from '@/components/icons';
import { del, post } from '@/lib/api';
import { fmt } from '@/lib/format';
import { ApprovalCard } from './ApprovalCard';

const STEP_ICON: Record<PlanStepStatus, [IconType, string]> = { pending: [IconTimer, 'pending'], running: [IconRefresh, 'running'], done: [IconOk, 'done'], failed: [IconBad, 'failed'], skipped: [IconClose, 'skipped'] };
const CLASS_BADGE: Record<string, [Tone, IconType, string]> = { read: ['mute', IconEye, 'baca'], change: ['warn', IconWrench, 'ubah'] };
const CMD_STATUS = (c: RunCommand): [Tone, string] => ({
  done: ['ok', 'selesai'], failed: ['bad', `gagal (exit ${c.exit_code})`], running: ['acc', 'berjalan'], rejected: ['mute', 'ditolak'], blocked: ['bad', 'diblokir'], approved: ['acc', 'disetujui']
} as Record<string, [Tone, string]>)[c.status] ?? ['mute', c.status];

function Plan({ run }: { run: Run }) {
  const n = run.steps.length, count = (s: PlanStepStatus) => run.steps.filter((x) => x.status === s).length;
  return (
    <div>
      <h2><IconList size={16} aria-hidden />Rencana</h2>
      {n ? (
        <>
          <Progress total={n} done={count('done')} running={count('running')} failed={count('failed')} />
          <div className="steps" style={{ marginTop: 8 }}>{run.steps.map((s) => {
            const [Icon, cls] = STEP_ICON[s.status] ?? STEP_ICON.pending;
            return (
              <div className="step" key={s.id}>
                <span className={`ico ${cls}`}><Icon size={16} aria-hidden className={s.status === 'running' ? 'spin' : undefined} /></span>
                <div><div className="t">{s.id}. {s.title}</div>{s.detail && <div className="d">{s.detail}</div>}{s.note && <div className="n">{s.note}</div>}</div>
              </div>
            );
          })}</div>
        </>
      ) : <div className="lbl">Tanpa rencana tertulis; agen menyusun sendiri dari tujuan.</div>}
      <h2 className="mt"><IconGauge size={16} aria-hidden />Anggaran</h2>
      <div className="lbl">Giliran {run.turns} dari {run.max_turns} | token {fmt(run.tokens)} dari {fmt(run.token_budget)}</div>
    </div>
  );
}

function CommandCard({ c }: { c: RunCommand }) {
  const [cTone, CIcon, cLabel] = CLASS_BADGE[c.class] ?? ['bad', IconBan, 'diblokir'] as [Tone, IconType, string];
  const [sTone, sLabel] = CMD_STATUS(c);
  return (
    <div className={`card${c.status === 'blocked' ? ' blk' : ''}`}>
      <div className="hd">
        <Badge tone={cTone} icon={CIcon}>{cLabel}</Badge>
        {c.status !== 'blocked' && <Badge tone={sTone}>{sLabel}</Badge>}
        <span className="lbl">#{c.id}{c.decided_by ? ` | ${c.decided_by}` : ''}</span>
      </div>
      <div className="bd">
        {c.purpose && <div className="thought">{c.purpose}</div>}
        <pre className="cmd">{c.command}</pre>
        {(c.status === 'blocked' || c.status === 'rejected') && <div className="lbl">{c.reason}</div>}
        {(c.stdout || c.stderr) && <details><summary>Keluaran{c.exit_code != null ? ` (exit ${c.exit_code})` : ''}</summary><pre className="out">{(c.stdout || '') + (c.stderr ? `\n[stderr]\n${c.stderr}` : '')}</pre></details>}
      </div>
    </div>
  );
}

type Event = { ts: number; command: RunCommand } | { ts: number; thought: RunThought };

/**
 * Susunan tumpukan: giliran terbaru di atas, jadi perintah yang menunggu persetujuan selalu terlihat tanpa menggulir.
 * Catatan agen menempel pada perintah sesudahnya (satu giliran = catatan lalu perintah), lalu urutan antar-giliran dibalik.
 */
export function turns(d: Pick<RunDetail, 'commands' | 'thoughts'>): Array<{ key: string; thought?: RunThought; command?: RunCommand }> {
  const events: Event[] = [...d.commands.map((command) => ({ ts: command.ts, command })), ...d.thoughts.map((thought) => ({ ts: thought.ts, thought }))].sort((a, b) => a.ts - b.ts);
  const out: Array<{ key: string; thought?: RunThought; command?: RunCommand }> = []; let pending: RunThought | undefined;
  for (const e of events) {
    if ('thought' in e) {
      if (!(e.thought.thought || e.thought.summary)) continue;
      if (e.thought.done) { if (pending) { out.push({ key: `t${pending.ts}`, thought: pending }); pending = undefined; } out.push({ key: `t${e.ts}`, thought: e.thought }); }   // ringkasan akhir berdiri sendiri
      else { if (pending) out.push({ key: `t${pending.ts}`, thought: pending }); pending = e.thought; }
    } else { out.push({ key: `c${e.command.id}`, thought: pending, command: e.command }); pending = undefined; }
  }
  if (pending) out.push({ key: `t${pending.ts}`, thought: pending });
  return out.reverse();
}

function Timeline({ d }: { d: RunDetail }) {
  const items = turns(d).map((t) => (
    <div className="turn" key={t.key}>
      {t.thought && <div className="thought">{t.thought.done ? `Selesai: ${t.thought.summary}` : t.thought.thought}</div>}
      {t.command && (t.command.status === 'pending_approval' ? <ApprovalCard command={t.command} /> : <CommandCard c={t.command} />)}
    </div>
  ));
  if (!items.length) return <Empty>{d.run.status === 'draft' ? 'Belum dimulai. Tekan Mulai; agen akan membaca kondisi server dulu.' : 'Menunggu balasan model...'}</Empty>;
  return <div className="tl">{items}</div>;
}

function Body({ id, d }: { id: string; d: RunDetail }) {
  const { confirm } = useDialogs(), navigate = useNavigate(), run = d.run;
  const active = run.status === 'running' || run.status === 'waiting_approval';
  const invalidate = [['runs'], ['overview']];
  const start = useAction(() => post(`/api/runs/${id}/start`), { success: 'Agen dimulai', invalidate });
  const stop = useAction(() => post(`/api/runs/${id}/stop`), { invalidate });
  const remove = useAction(() => del(`/api/runs/${id}`), { invalidate, onSuccess: () => navigate('/setup') });
  const confirmDelete = async () => { if (await confirm('Hapus proses ini beserta seluruh riwayat perintahnya?', 'Hapus')) await remove.mutateAsync(); };
  return (
    <>
      <PageHead title={run.name} icon={IconWrench}>
        <RunStatusBadge status={run.status} />
        {active ? <Button icon={IconStop} onClick={() => stop.mutateAsync()}>Hentikan</Button> : <Button primary icon={IconPlay} onClick={() => start.mutateAsync()}>{run.status === 'draft' ? 'Mulai' : 'Jalankan lagi'}</Button>}
        <Button icon={IconTrash} aria-label="Hapus proses" onClick={confirmDelete} />
      </PageHead>
      <div className="lbl" style={{ margin: '-8px 0 16px' }}>{run.server_name ?? 'tanpa server'} | tujuan: {run.goal}</div>
      {run.summary && <Hint><span>{run.summary}</span></Hint>}
      <div className="cols wide-left">
        <div><h2><IconTerminal size={16} aria-hidden />Jalannya agen</h2><p className="lbl" style={{ marginBottom: 8 }}>Terbaru di atas. Perintah yang menunggu persetujuan selalu muncul paling atas.</p><Timeline d={d} /></div>
        <Plan run={run} />
      </div>
    </>
  );
}

export function RunPage() {
  const id = String(useParams().id), query = useQuery(q.run(id));
  return <Async query={query}>{(d) => <Body id={id} d={d} />}</Async>;
}

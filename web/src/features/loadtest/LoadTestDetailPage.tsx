import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAction } from '@/api/queries';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Charts';
import { DataTable } from '@/components/ui/DataTable';
import { Hint, Note, PageHead, Section } from '@/components/ui/Layout';
import { IconAlert, IconBan, IconCheck, IconCopy, IconGauge, IconLayers, IconPulse, IconSpark, IconTrash } from '@/components/icons';
import { del, post } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { peakVus, totalSeconds } from './form';
import { ArchitectureView } from './ArchitectureView';
import { BottleneckPanel } from './BottleneckPanel';
import { P95Chart, ThroughputChart } from './StageCharts';
import { STATUS_BADGE } from './LoadTestsPage';
import { isActive, loadQ } from './queries';
import type { AiExplanation, LoadTestDetail } from './types';

const ms = (v: number) => `${Math.round(v)} ms`;

/** Penjelasan dikerjakan di server dan disimpan di uji ini: pindah halaman atau tab tidak membatalkannya, dan hasilnya tetap ada saat kembali. */
function AiExplain({ id, ai }: { id: number; ai: AiExplanation | null }) {
  const ask = useAction(() => post(`/api/loadtests/${id}/explain`), { invalidate: [['loadtests', 'detail', id]] });
  const running = ai?.status === 'running' || ask.isPending;
  return (
    <Section title="Penjelasan AI" icon={IconSpark}>
      <Button icon={IconSpark} disabled={running} onClick={() => ask.mutateAsync()}>{running ? 'Sedang menjelaskan...' : ai?.status === 'done' ? 'Minta ulang' : ai?.status === 'failed' ? 'Coba lagi' : 'Jelaskan hasil ini'}</Button>
      {running && <p className="lbl" role="status" style={{ marginTop: 8 }}>Dikerjakan di server. Anda boleh pindah halaman atau tab; hasilnya tersimpan dan muncul di sini.</p>}
      {ai?.status === 'failed' && <Hint icon={IconAlert}><span>Penjelasan gagal dibuat: {ai.error}</span></Hint>}
      {ai?.status === 'done' && <><div className="lbl" style={{ margin: '8px 0 4px' }}>Ditulis AI ({ai.model}) dari angka di atas{ai.ts ? `, ${ago(ai.ts)}` : ''}; ini tafsiran, bukan pengukuran. Verifikasi dengan metrik server.</div><p style={{ whiteSpace: 'pre-wrap' }}>{ai.text}</p></>}
    </Section>
  );
}

function Results({ t }: { t: LoadTestDetail }) {
  const a = t.analysis, kneeIdx = a.knee?.idx;
  const scrapeLabels = Array.from(new Set(t.stages.flatMap((s) => Object.keys(s.scraped))));
  return (
    <>
      <div className={`verdict ${a.verdict.tone}`} role="status"><b>{a.verdict.title}</b><p>{a.verdict.text}</p></div>
      <div className="cols sec">
        <div className="panel"><h2><IconPulse size={16} aria-hidden />Waktu respons p95</h2><P95Chart stages={t.stages} criteria={t.criteria} kneeVus={a.knee?.vus} /><div className="lbl">sumbu X = pengguna per tahap; garis merah = batas {t.criteria.p95Ms} ms</div></div>
        <div className="panel"><h2><IconGauge size={16} aria-hidden />Throughput</h2><ThroughputChart stages={t.stages} /><div className="lbl">request per detik yang berhasil dilayani</div></div>
      </div>
      {t.status === 'done' && t.bottleneck && t.stages.length > 0 && <Section title="Di mana bottleneck-nya" icon={IconAlert}><BottleneckPanel report={t.bottleneck} /></Section>}
      {t.architecture && t.stages.length > 0 && <Section title="Arsitektur dan penempatan komponen" icon={IconLayers}><ArchitectureView arch={t.architecture} /></Section>}
      <Section title="Hasil per tahap" icon={IconGauge}>
        <DataTable textCols={1} heads={['Tahap', 'Pengguna', 'Req/dtk', 'p50', 'p95', 'p99', 'Error', 'CPU pembangkit']} empty="Belum ada tahap yang selesai."
          rows={t.stages.map((s) => [
            <span key="n">{s.idx + 1}{s.idx === kneeIdx && <> <Badge tone="bad">lutut</Badge></>}{a.healthy?.idx === s.idx && <> <Badge tone="ok">sehat terakhir</Badge></>}</span>,
            String(s.vus), s.rps.toFixed(1), ms(s.p50), ms(s.p95), ms(s.p99), `${s.errPct.toFixed(1)}%`,
            <span key="c">{Math.round(s.genCpu * 100)}%{!s.valid && <> <Badge tone="warn">tidak murni</Badge></>}</span>
          ])} />
      </Section>
      {t.status === 'done' && t.stages.length > 0 && <AiExplain id={t.id} ai={t.ai} />}
      {scrapeLabels.length > 0 && (
        <Section title="Metrik server uji per tahap (rata-rata / puncak)" icon={IconPulse}>
          <DataTable textCols={1} heads={['Tahap (pengguna)', ...scrapeLabels]} empty=""
            rows={t.stages.map((s) => [`${s.idx + 1} (${s.vus})`, ...scrapeLabels.map((l) => (s.scraped[l] ? `${s.scraped[l]!.avg.toFixed(1)} / ${s.scraped[l]!.max.toFixed(1)}` : '-'))])} />
          <Note>Cari metrik yang mendekati batasnya tepat di tahap lutut: itu komponen yang jenuh lebih dulu.</Note>
        </Section>
      )}
    </>
  );
}

export function LoadTestDetailPage() {
  const id = Number(useParams().id), [gone, setGone] = useState(false), query = useQuery({ ...loadQ.detail(id), enabled: !gone }), navigate = useNavigate(), { confirm } = useDialogs();
  const invalidate = [['loadtests']];
  const run = useAction((t: LoadTestDetail) => post(`/api/loadtests/${t.id}/run`), { success: 'Disetujui. Runner akan menjalankannya.', invalidate });
  const cancel = useAction(() => post(`/api/loadtests/${id}/cancel`), { success: 'Pembatalan diminta', invalidate });
  const again = useAction(() => post<{ id: number }>(`/api/loadtests/${id}/duplicate`), { invalidate, onSuccess: (n) => navigate(`/uji-beban/${n.id}`) });
  const remove = useAction(() => del(`/api/loadtests/${id}`), { invalidate: [['loadtests', 'list']], onSuccess: () => { setGone(true); navigate('/uji-beban'); } });   // setelah dihapus, detail tidak boleh diambil ulang (404)

  const approve = async (t: LoadTestDetail) => {
    const ok = await confirm(
      `Menjalankan uji beban ke ${t.target}.\n\n${t.plan.length} tahap, puncak ${peakVus(t.plan)} pengguna, total ${totalSeconds(t.plan)} detik.\nPastikan ini BUKAN server produksi dan bukan layanan milik orang lain.`,
      'Setujui dan jalankan'
    );
    if (ok) await run.mutateAsync(t);
  };

  return (
    <Async query={query}>{(t) => {
      const [tone, label] = STATUS_BADGE[t.status], active = isActive(t.status);
      return (
        <>
          <PageHead title={t.name} icon={IconGauge}>
            <Badge tone={tone}>{label}</Badge>
            {t.status === 'draft' && <Button primary icon={IconCheck} onClick={() => approve(t)}>Setujui dan jalankan</Button>}
            {active && <Button icon={IconBan} onClick={() => cancel.mutateAsync()}>Batalkan</Button>}
            {!active && t.status !== 'draft' && <Button icon={IconCopy} onClick={() => again.mutateAsync()}>Jalankan lagi</Button>}
            {!active && <Button icon={IconTrash} aria-label="Hapus uji" onClick={async () => { if (await confirm(`Hapus uji "${t.name}" beserta hasilnya?`, 'Hapus')) await remove.mutateAsync(); }} />}
            <Badge tone="acc" to="/uji-beban">Semua uji</Badge>
          </PageHead>
          <div className="lbl" style={{ margin: '-8px 0 14px' }}>
            {t.target} | {t.scenario.requests.map((r) => `${r.method} ${r.path} (${r.weight})`).join(', ')} | jeda {t.scenario.thinkSeconds} dtk | kriteria p95 ≤ {t.criteria.p95Ms} ms, error ≤ {t.criteria.errPct}%
            {t.approved_by ? ` | disetujui ${t.approved_by}` : ''}{t.started ? ` | mulai ${dateTime(t.started)}` : ''}
          </div>
          {t.status === 'queued' && <Hint icon={IconAlert}>Menunggu runner mengambil uji ini. Bila terlalu lama, periksa bahwa kontainer runner berjalan (<code>docker compose --profile loadtest up -d</code>).</Hint>}
          {t.status === 'running' && <div style={{ marginBottom: 14 }}><Progress total={t.plan.length} done={t.stages.length} running={1} failed={0} /><div className="lbl" style={{ marginTop: 4 }}>Berjalan: {t.stages.length} dari {t.plan.length} tahap sudah dilaporkan. Halaman menyegarkan diri.</div></div>}
          {(t.status === 'failed' || t.status === 'cancelled') && t.error && <Hint icon={IconAlert}><span>{t.error}</span></Hint>}
          {t.status === 'draft' ? (
            <Note>Ini masih draf dan belum berjalan. Periksa rencananya: {t.plan.map((s) => `${s.vus} pengguna x ${s.seconds} dtk`).join(', ')}. Tekan "Setujui dan jalankan" bila sudah benar.</Note>
          ) : <Results t={t} />}
        </>
      );
    }}</Async>
  );
}

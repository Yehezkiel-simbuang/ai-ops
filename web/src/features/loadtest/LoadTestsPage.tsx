import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Async } from '@/components/ui/Async';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Empty, Hint, Item, List, PageHead } from '@/components/ui/Layout';
import { IconGauge, IconInfo, IconPlus } from '@/components/icons';
import { ago } from '@/lib/format';
import { NewLoadTestForm } from './NewLoadTestForm';
import { loadQ } from './queries';
import type { LoadTestStatus, TestStatus } from './types';

export const STATUS_BADGE: Record<TestStatus, [Tone, string]> = {
  draft: ['mute', 'Draf'], queued: ['warn', 'Antre'], running: ['acc', 'Berjalan'], done: ['ok', 'Selesai'], failed: ['bad', 'Gagal'], cancelled: ['mute', 'Dibatalkan']
};

function RunnerStatus({ status }: { status: LoadTestStatus | undefined }) {
  if (!status) return null;
  if (!status.enabled) return <Hint icon={IconInfo}><span>Uji beban belum aktif: rahasia runner belum disetel. Jalankan <code>node scripts/init-secrets.mjs</code> (membuat <code>secrets/loadgen_secret.txt</code>), lalu <code>docker compose --profile loadtest up -d --build</code>.</span></Hint>;
  if (!status.runner.online) return <Hint icon={IconInfo}><span>Runner pembangkit beban belum terhubung. Nyalakan dengan <code>docker compose --profile loadtest up -d --build</code>. Uji yang sudah disetujui akan menunggu sampai runner online.</span></Hint>;
  const i = status.runner.info;
  return <p className="lbl" style={{ marginBottom: 12 }}><Badge tone="ok">runner online</Badge> {i ? `${i.k6} | ${i.cpus} CPU` : ''}</p>;
}

export function LoadTestsPage() {
  const [params] = useSearchParams(), prefill = { target: params.get('target') ?? undefined, name: params.get('nama') ?? undefined, playgroundId: Number(params.get('pg')) || undefined };   // dari halaman Playground
  const [creating, setCreating] = useState(!!prefill.target), navigate = useNavigate(), [picked, setPicked] = useState<number[]>([]);
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 4 ? [...p, id] : p));
  const status = useQuery(loadQ.status()), list = useQuery(loadQ.list());
  return (
    <>
      <PageHead title="Uji beban" icon={IconGauge}>
        {picked.length >= 2 && <Button onClick={() => navigate(`/uji-beban/banding?ids=${picked.join(',')}`)}>Bandingkan ({picked.length})</Button>}
        <Button primary icon={IconPlus} disabled={!status.data?.enabled} onClick={() => setCreating(true)}>Uji baru</Button>
      </PageHead>
      <p className="note" style={{ marginBottom: 12 }}>Menaikkan beban bertahap ke server uji (bukan produksi) dan mencatat di mana ia mulai tidak sehat. Hasilnya <b>terukur</b>, bukan perkiraan. Tiap uji menunggu persetujuan Anda sebelum berjalan.</p>
      <RunnerStatus status={status.data} />
      {creating && <div style={{ marginBottom: 18 }}><NewLoadTestForm status={status.data} prefill={prefill} onCreated={(id) => navigate(`/uji-beban/${id}`)} onCancel={() => setCreating(false)} /></div>}
      <Async query={list}>{(tests) => tests.length ? (
        <List>{tests.map((t) => {
          const [tone, label] = STATUS_BADGE[t.status];
          return (
            <Item key={t.id} to={`/uji-beban/${t.id}`} title={t.name} sub={[`${t.target} | ${t.stages.length} tahap, puncak ${Math.max(...t.stages.map((s) => s.vus))} pengguna | ${ago(t.created)}`, t.stageCount ? t.analysis.verdict.title : t.error]}>
              {t.status === 'done' && <label className="checkline" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Pilih ${t.name} untuk dibandingkan`} checked={picked.includes(t.id)} onChange={() => toggle(t.id)} /><span className="lbl">banding</span></label>}
              <Badge tone={tone}>{label}{t.status === 'running' ? ` ${t.stageCount}/${t.stages.length}` : ''}</Badge>
            </Item>
          );
        })}</List>
      ) : <Empty>Belum ada uji beban. Tekan "Uji baru" untuk membuat yang pertama.</Empty>}</Async>
    </>
  );
}

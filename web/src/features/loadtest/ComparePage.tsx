// Perbandingan 2-4 uji beban berdampingan: susunan yang diuji, tahap sehat terakhir, lutut, dan hasil per tahap.
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { Hint, Note, PageHead, Section } from '@/components/ui/Layout';
import { IconGauge, IconInfo } from '@/components/icons';
import { get } from '@/lib/api';
import type { Analysis } from './types';

export interface CompareItem {
  id: number; name: string; status: string; setup: { name: string; services: Array<{ name: string; image: string }>; limits: string[] } | null;
  criteria: { p95Ms: number; errPct: number }; healthy: Analysis['healthy']; knee: Analysis['knee']; verdict: Analysis['verdict'];
  stages: Array<{ vus: number; rps: number; p95: number; errPct: number; valid: boolean }>;
}

/** Selisih kapasitas sehat terhadap uji pertama (pembanding), dalam persen. null bila salah satunya belum punya tahap sehat. */
export function capacityDelta(base: CompareItem, other: CompareItem): number | null {
  if (!base.healthy || !other.healthy || base.healthy.rps <= 0) return null;
  return Math.round(((other.healthy.rps - base.healthy.rps) / base.healthy.rps) * 100);
}

export function ComparePage() {
  const ids = (useSearchParams()[0].get('ids') ?? '').split(',').filter(Boolean).join(',');
  const query = useQuery({ queryKey: ['loadtests', 'compare', ids], queryFn: () => get<CompareItem[]>(`/api/loadtests/compare?ids=${ids}`), enabled: ids.includes(',') });
  const maxStages = (list: CompareItem[]) => Math.max(...list.map((t) => t.stages.length));
  return (
    <>
      <PageHead title="Bandingkan uji beban" icon={IconGauge}><Badge tone="acc" to="/uji-beban">Semua uji</Badge></PageHead>
      {!ids.includes(',') && <Hint icon={IconInfo}><span>Pilih 2 sampai 4 uji di <Link to="/uji-beban">daftar uji beban</Link>, lalu tekan Bandingkan.</span></Hint>}
      {ids.includes(',') && <Async query={query}>{(list) => (
        <>
          <Section title="Ringkasan" icon={IconGauge}>
            <DataTable textCols={2} heads={['Uji', 'Susunan', 'Sehat sampai (req/dtk)', 'Mulai tidak sehat', 'Selisih kapasitas']} empty=""
              rows={list.map((t, i) => [
                t.name,
                t.setup ? `${t.setup.name}: ${t.setup.services.map((s) => s.name).join(', ')}${t.setup.limits.length ? ` (${t.setup.limits.join('; ')})` : ''}` : 'tidak dicatat',
                t.healthy ? `${t.healthy.vus} pengguna (${t.healthy.rps.toFixed(1)})` : '-',
                t.knee ? `${t.knee.vus} pengguna: ${t.knee.reason}` : t.healthy ? 'tidak tercapai' : '-',
                i === 0 ? 'pembanding' : (() => { const d = capacityDelta(list[0]!, t); return d === null ? '-' : `${d > 0 ? '+' : ''}${d}%`; })()
              ])} />
            <Note>Selisih dihitung dari throughput tahap sehat terakhir terhadap uji pertama. Bandingkan hanya uji dengan skenario, tahap, dan kriteria yang sama; kriteria berbeda membuat "sehat" bermakna lain.</Note>
          </Section>
          <Section title="Hasil per tahap (p95 ms / req per detik)" icon={IconGauge}>
            <DataTable textCols={1} heads={['Tahap', ...list.map((t) => t.name)]} empty=""
              rows={Array.from({ length: maxStages(list) }, (_, i) => [String(i + 1), ...list.map((t) => { const s = t.stages[i]; return s ? `${s.vus} pengguna: ${Math.round(s.p95)} ms / ${s.rps.toFixed(1)}${s.errPct > 0 ? `, err ${s.errPct.toFixed(1)}%` : ''}${s.valid ? '' : ' (tidak murni)'}` : '-'; })])} />
          </Section>
        </>
      )}</Async>}
    </>
  );
}

// Armada agen: semua server dengan status agennya. Yang mati atau belum terhubung ditampilkan di depan supaya tidak terlewat.
import { useQuery } from '@tanstack/react-query';
import { q } from '@/api/queries';
import type { FleetAgent } from '@/api/types';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Item, List, Section } from '@/components/ui/Layout';
import { IconPulse } from '@/components/icons';
import { ago } from '@/lib/format';

const STATE: Record<FleetAgent['state'], [Tone, string]> = { hidup: ['ok', 'hidup'], mati: ['bad', 'mati'], belum_terhubung: ['warn', 'belum terhubung'], belum_dipasang: ['mute', 'belum dipasang'] };

/** Ringkasan satu kalimat, mis. "12 hidup, 1 mati, 3 belum dipasang". */
export function fleetSummary(rows: FleetAgent[]): string {
  const n = (s: FleetAgent['state']) => rows.filter((r) => r.state === s).length;
  return [n('hidup') && `${n('hidup')} hidup`, n('mati') && `${n('mati')} mati`, n('belum_terhubung') && `${n('belum_terhubung')} belum terhubung`, n('belum_dipasang') && `${n('belum_dipasang')} belum dipasang`].filter(Boolean).join(', ');
}

export function AgentFleet() {
  const query = useQuery(q.agents()), rows = query.data;
  if (!rows || !rows.some((r) => r.state !== 'belum_dipasang')) return null;   // belum ada agen sama sekali: tidak ada yang perlu dipantau di sini
  const attention = rows.filter((r) => r.state === 'mati' || r.state === 'belum_terhubung');
  return (
    <Section title="Armada agen" icon={IconPulse}>
      <p className={attention.length ? 'lbl' : 'lbl calm'}>{fleetSummary(rows)}{attention.length === 0 && '. Semua agen yang dipasang melapor.'}</p>
      {attention.length > 0 && (
        <List>{attention.map((r) => (
          <Item key={r.server_id} to={`/agen/${r.server_id}`} title={r.name} sub={[r.last_seen ? `terakhir terlihat ${ago(r.last_seen)}` : 'belum pernah menghubungi aplikasi; periksa pemasangannya']}>
            <Badge tone={STATE[r.state][0]}>{STATE[r.state][1]}</Badge>
          </Item>
        ))}</List>
      )}
    </Section>
  );
}

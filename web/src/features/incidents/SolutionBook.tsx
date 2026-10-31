// Buku solusi di halaman insiden: catatan penyebab dan penyelesaian, tutup manual, dan insiden serupa yang pernah terjadi.
import { useState } from 'react';
import { useAction } from '@/api/queries';
import type { Incident, SimilarIncident } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Hint, Item, List } from '@/components/ui/Layout';
import { IconBook, IconCheck, IconHistory, IconSave } from '@/components/icons';
import { post, put } from '@/lib/api';
import { ago } from '@/lib/format';

export function NotesPanel({ inc }: { inc: Incident }) {
  const [cause, setCause] = useState(inc.cause ?? ''), [solution, setSolution] = useState(inc.solution ?? '');
  const save = useAction(() => put(`/api/incidents/${inc.id}/notes`, { cause, solution }), { invalidate: [['incidents']], success: 'Catatan disimpan' });
  const dirty = cause !== (inc.cause ?? '') || solution !== (inc.solution ?? '');
  return (
    <section style={{ marginBottom: 16 }}>
      <h3 className="row"><IconBook size={18} aria-hidden /> Catatan penyebab dan penyelesaian</h3>
      <Hint icon={IconBook}><span>Isi sesudah Anda tahu penyebabnya. Bila masalah serupa muncul lagi (di server mana pun), catatan ini tampil sebagai contekan.</span></Hint>
      <Field label="Penyebab"><textarea rows={2} maxLength={2000} value={cause} onChange={(e) => setCause(e.target.value)} placeholder="mis. server di-restart saat kontainer belum menyala" /></Field>
      <Field label="Penyelesaian"><textarea rows={3} maxLength={4000} value={solution} onChange={(e) => setSolution(e.target.value)} placeholder="mis. jalankan docker compose up -d di folder susunan" /></Field>
      <div className="row">
        <Button icon={IconSave} disabled={!dirty} onClick={() => save.mutateAsync()}>Simpan catatan</Button>
        {inc.noted_by && inc.noted_at && <span className="lbl">Terakhir oleh {inc.noted_by}, {ago(inc.noted_at)}</span>}
      </div>
    </section>
  );
}

export function CloseButton({ inc }: { inc: Incident }) {
  const { promptText } = useDialogs();
  const close = useAction((reason: string) => post(`/api/incidents/${inc.id}/close`, { reason }), { invalidate: [['incidents'], ['overview']], success: 'Insiden ditutup' });
  if (inc.status !== 'open') return null;
  return <Button icon={IconCheck} title="Tutup tanpa menunggu laporan pulih dari agen" onClick={async () => { const reason = await promptText('Tutup insiden ini secara manual? Bila kondisinya masih buruk, agen akan membuka insiden baru.', 'Alasan penutupan'); if (reason) await close.mutateAsync(reason); }}>Tutup manual</Button>;
}

export function Similar({ items }: { items: SimilarIncident[] }) {
  if (!items.length) return null;
  return (
    <section style={{ marginBottom: 16 }}>
      <h3 className="row"><IconHistory size={18} aria-hidden /> Pernah terjadi sebelumnya ({items.length})</h3>
      <List>{items.map((s) => (
        <Item key={s.id} title={s.title} sub={[
          `${s.server_name} | ${ago(s.opened)}${s.score === 3 ? ' | server dan kunci sama' : s.score === 2 ? ' | kunci sama di server lain' : ' | jenis sama'}`,
          s.cause && `Penyebab: ${s.cause}`, s.solution && `Penyelesaian: ${s.solution}`,
          s.closed_reason && `Ditutup manual oleh ${s.closed_by}: ${s.closed_reason}`,
          s.worked.length > 0 && `Perbaikan yang dulu berhasil: ${s.worked.map((w) => `${w.title} (${w.command})`).join('; ')}`
        ].filter(Boolean) as string[]}><Badge tone="acc" to={`/insiden/${s.id}`}>Buka</Badge></Item>
      ))}</List>
    </section>
  );
}

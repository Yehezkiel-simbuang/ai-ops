// Skenario tersimpan: simpan eksperimen saat ini, muat kembali, hapus.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAction } from '@/api/queries';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Button } from '@/components/ui/Button';
import { Item, List, Note } from '@/components/ui/Layout';
import { IconFolder, IconSave, IconTrash } from '@/components/icons';
import { del, post } from '@/lib/api';
import { ago } from '@/lib/format';
import { labQ } from './queries';
import type { LabDesign, Scenario } from './types';

export function Designs({ scenario, onLoad }: { scenario: Scenario; onLoad: (d: LabDesign) => void }) {
  const { confirm } = useDialogs(), designs = useQuery(labQ.designs(scenario.project));
  const [name, setName] = useState('');
  const invalidate = [['lab', 'designs', scenario.project]];
  const save = useAction(() => post('/api/lab/designs', { ...scenario, name: name.trim() }), { success: 'Skenario disimpan', invalidate, onSuccess: () => setName('') });
  const remove = useAction((id: number) => del(`/api/lab/designs/${id}`), { invalidate });
  return (
    <div className="stack">
      <div className="row">
        <input style={{ flex: '1 1 160px' }} placeholder="nama skenario, mis. Redis + 3 server" aria-label="Nama skenario" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <Button primary icon={IconSave} disabled={!name.trim()} onClick={() => save.mutateAsync()}>Simpan</Button>
      </div>
      {designs.data?.length ? (
        <List>{designs.data.map((d) => (
          <Item key={d.id} title={d.name} sub={[`${d.actions.length} perubahan · ${ago(d.updated)}`]}>
            <Button icon={IconFolder} onClick={() => onLoad(d)}>Buka</Button>
            <Button icon={IconTrash} aria-label={`Hapus ${d.name}`} onClick={async () => { if (await confirm(`Hapus skenario "${d.name}"?`, 'Hapus')) await remove.mutateAsync(d.id); }} />
          </Item>
        ))}</List>
      ) : <Note>Belum ada skenario tersimpan untuk proyek ini.</Note>}
    </div>
  );
}

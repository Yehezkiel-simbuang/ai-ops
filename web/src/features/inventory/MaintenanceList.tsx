// Jadwal pemeliharaan: baris tugas (selesai/tunda/hapus), formulir tugas baru, dan penambahan dari templat standar.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { q, useAction } from '@/api/queries';
import type { MaintenanceTask, NewTask } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, useForm } from '@/components/ui/Field';
import { Empty, Item, List } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconCheck, IconClose, IconTimer, IconTrash } from '@/components/icons';
import { del, post } from '@/lib/api';
import { dateInputToMs, dateStr, dueText } from '@/lib/format';

const STATUS_TONE: Record<MaintenanceTask['status'], Tone> = { terlambat: 'bad', segera: 'warn', ok: 'ok', nonaktif: 'mute' };
const refreshKeys = (serverId: number) => [['maintenance'], ['servers', serverId, 'tasks'], ['servers', serverId, 'task-log'], ['inventory'], ['overview']];

/** Tombol aksi satu tugas; dipakai di daftar (halaman server) dan di tabel Pemeliharaan. */
export function TaskActions({ t }: { t: MaintenanceTask }) {
  const { confirm, promptText } = useDialogs(), invalidate = refreshKeys(t.server_id);
  const complete = useAction(async () => {
    const notes = await promptText('Catatan pengerjaan (opsional).', 'Catatan');
    if (notes === null) return null;
    return post(`/api/maintenance/${t.id}/complete`, { notes });
  }, { invalidate, success: (r) => (r ? 'Dicatat selesai' : null) });
  const snooze = useAction(() => post(`/api/maintenance/${t.id}/snooze`, { days: 7 }), { invalidate });
  const remove = useAction(async () => { if (await confirm(`Hapus tugas "${t.title}"?`, 'Hapus')) await del(`/api/maintenance/${t.id}`); }, { invalidate });
  return (
    <>
      <Button primary icon={IconCheck} onClick={() => complete.mutateAsync()}>Selesai</Button>
      <Button icon={IconTimer} onClick={() => snooze.mutateAsync()}>Tunda 7 hari</Button>
      <Button icon={IconTrash} aria-label={`Hapus ${t.title}`} onClick={() => remove.mutateAsync()} />
    </>
  );
}

export const taskWhen = (t: MaintenanceTask) => `${t.category || ''}${t.every_days ? ` | tiap ${t.every_days} hari` : ' | sekali'} | jatuh tempo ${dateStr(t.due_at)}${t.last_done ? ` | terakhir ${dateStr(t.last_done)}` : ''}`;
export const taskBadges = (t: MaintenanceTask) => (
  <>
    <Badge tone={STATUS_TONE[t.status] ?? 'mute'}>{dueText(t.due_at)}</Badge>
    {t.priority === 'tinggi' && <Badge tone="bad">prioritas tinggi</Badge>}
  </>
);

function TaskRow({ t, withServer }: { t: MaintenanceTask; withServer: boolean }) {
  return (
    <Item title={`${withServer && t.server_name ? `${t.server_name} | ` : ''}${t.title}`} sub={[taskWhen(t), t.description]}>
      {taskBadges(t)}
      <TaskActions t={t} />
    </Item>
  );
}

export function TaskList({ tasks, withServer = false, empty }: { tasks: MaintenanceTask[]; withServer?: boolean; empty: string }) {
  if (!tasks.length) return <Empty>{empty}</Empty>;
  return <List>{tasks.map((t) => <TaskRow key={t.id} t={t} withServer={withServer} />)}</List>;
}

function TaskForm({ serverId, onClose }: { serverId: number; onClose: () => void }) {
  const { values, bind } = useForm({ title: '', description: '', every: '', due: '', priority: 'normal' });
  const save = useAction(() => post(`/api/servers/${serverId}/maintenance`, {
    title: values.title, description: values.description, every_days: values.every === '' ? null : Number(values.every), due_at: dateInputToMs(String(values.due)), priority: values.priority
  } satisfies NewTask), { success: 'Tugas ditambahkan', invalidate: refreshKeys(serverId), onSuccess: onClose });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h2><IconTimer size={16} aria-hidden />Tugas pemeliharaan baru</h2>
      <Field label="Judul"><input required placeholder="mis. Ganti baterai UPS" {...bind('title')} /></Field>
      <Field label="Keterangan"><input {...bind('description')} /></Field>
      <div className="cols tight">
        <Field label="Ulangi tiap (hari)"><input type="number" min={1} max={3650} placeholder="kosong = sekali" {...bind('every')} /></Field>
        <Field label="Jatuh tempo pertama"><input type="date" {...bind('due')} /></Field>
      </div>
      <Field label="Prioritas"><select {...bind('priority')}>{['normal', 'tinggi', 'rendah'].map((p) => <option key={p}>{p}</option>)}</select></Field>
      <div className="row"><button type="submit" className="primary" disabled={save.isPending}><IconCheck size={16} aria-hidden />Simpan</button><Button icon={IconClose} onClick={onClose}>Batal</Button></div>
    </form>
  );
}

export function NewTaskDialog({ serverId, open, onClose }: { serverId: number; open: boolean; onClose: () => void }) {
  return <Modal open={open} onClose={onClose}><TaskForm serverId={serverId} onClose={onClose} /></Modal>;
}

export function TemplatePicker({ serverId }: { serverId: number }) {
  const templates = useQuery(q.maintenanceTemplates()), [chosen, setChosen] = useState<string[]>([]);
  const add = useAction(() => post<{ added: unknown[] }>(`/api/servers/${serverId}/maintenance/templates`, { ids: chosen }), {
    success: (r) => `${r.added.length} tugas ditambahkan`, invalidate: refreshKeys(serverId), onSuccess: () => setChosen([])
  });
  const toggle = (id: string, on: boolean) => setChosen((c) => (on ? [...c, id] : c.filter((x) => x !== id)));
  return (
    <details style={{ marginTop: 14 }}>
      <summary>Tambah dari templat standar</summary>
      <div className="body">
        {templates.data?.map((t) => <label key={t.id} className="checkline"><input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => toggle(t.id, e.target.checked)} /><span>{t.title} (tiap {t.every_days} hari)</span></label>)}
        <div className="row"><Button icon={IconCheck} onClick={async () => { if (chosen.length) await add.mutateAsync(); }}>Tambahkan yang dicentang</Button></div>
      </div>
    </details>
  );
}

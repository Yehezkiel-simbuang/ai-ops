// Notifikasi ke Anda: kanal, level minimum, pengingat, riwayat pengiriman.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { q, useAction } from '@/api/queries';
import type { AppSettings, Channel, ChannelType, NewChannel, NotifyLevel } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Async } from '@/components/ui/Async';
import { Button } from '@/components/ui/Button';
import { DataTable } from '@/components/ui/DataTable';
import { Field } from '@/components/ui/Field';
import { Empty, Item, List, Note, Section } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconBell, IconClose, IconPlus, IconSend, IconTrash } from '@/components/icons';
import { del, post, put } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { CHANNEL_TYPES, LEVELS, defaultConfig } from './channelTypes';

function ChannelRow({ c }: { c: Channel }) {
  const { confirm } = useDialogs(), invalidate = [['channels'], ['notifications']];
  const update = useAction((patch: Partial<Pick<Channel, 'min_level' | 'enabled'>>) => put(`/api/channels/${c.id}`, { name: c.name, min_level: c.min_level, enabled: c.enabled, ...patch }), { success: 'Disimpan', invalidate });
  const test = useAction(() => post<{ ok: boolean; error?: string }>(`/api/channels/${c.id}/test`), { invalidate, onSuccess: (r) => toast(r.ok ? `Terkirim ke ${c.name}` : `Gagal: ${r.error}`, !r.ok) });
  const remove = useAction(() => del(`/api/channels/${c.id}`), { invalidate });
  return (
    <Item title={c.name} sub={[CHANNEL_TYPES[c.type]?.label ?? c.type]}>
      <select aria-label={`Level minimum ${c.name}`} value={c.min_level} onChange={(e) => update.mutate({ min_level: e.target.value as NotifyLevel })}>{LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <label className="checkline"><input type="checkbox" checked={c.enabled} aria-label={`Aktif ${c.name}`} onChange={(e) => update.mutate({ enabled: e.target.checked })} /><span>aktif</span></label>
      <Button icon={IconSend} onClick={() => test.mutateAsync()}>Kirim uji</Button>
      <Button icon={IconTrash} aria-label={`Hapus ${c.name}`} onClick={async () => { if (await confirm(`Hapus kanal ${c.name}?`, 'Hapus')) await remove.mutateAsync(); }} />
    </Item>
  );
}

function NewChannelForm({ onDone }: { onDone: () => void }) {
  const [type, setType] = useState<ChannelType>('telegram'), [name, setName] = useState(''), [level, setLevel] = useState<NotifyLevel>('kritis');
  const [config, setConfig] = useState(() => defaultConfig('telegram'));
  const info = CHANNEL_TYPES[type];
  const add = useAction(
    () => post('/api/channels', { type, name: name || info.label, min_level: level, config } satisfies NewChannel),
    { success: 'Kanal ditambahkan. Tekan "Kirim uji" untuk memastikan.', invalidate: [['channels']], onSuccess: () => { setName(''); setConfig(defaultConfig(type)); onDone(); } }
  );
  const changeType = (t: ChannelType) => { setType(t); setConfig(defaultConfig(t)); };
  return (
    <div className="form">
      <h3>Tambah kanal</h3>
      <Field label="Jenis"><select aria-label="Jenis kanal" value={type} onChange={(e) => changeType(e.target.value as ChannelType)}>{Object.entries(CHANNEL_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
      <Field label="Nama"><input placeholder="nama kanal" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="form">{info.fields.map((f) => (
        <Field key={`${type}-${f.key}`} label={f.label}><input type={f.secret ? 'password' : 'text'} className={f.secret ? undefined : 'mono'} autoComplete="off" value={config[f.key] ?? ''} onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))} /></Field>
      ))}</div>
      <p className="lbl">{info.hint}</p>
      <Field label="Kirim untuk"><select value={level} onChange={(e) => setLevel(e.target.value as NotifyLevel)}>{LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <div className="row"><Button primary icon={IconPlus} onClick={() => add.mutateAsync()}>Tambah kanal</Button><Button icon={IconClose} onClick={onDone}>Batal</Button></div>
    </div>
  );
}

function Preferences({ settings }: { settings: AppSettings }) {
  const [reminder, setReminder] = useState(String(settings.reminder_min));
  const save = useAction((patch: Partial<AppSettings>) => post('/api/settings', patch), { success: 'Disimpan', invalidate: [['settings']] });
  return (
    <>
      <div className="row" style={{ marginTop: 12 }}>
        <span className="lbl">Ingatkan lagi tiap</span>
        <input type="number" min={0} max={1440} className="input-md" aria-label="Interval pengingat menit" value={reminder} onChange={(e) => setReminder(e.target.value)} onBlur={() => save.mutate({ reminder_min: Number(reminder) })} />
        <span className="lbl">menit selama kritis belum ditandai dilihat (0 = mati)</span>
      </div>
      <label className="checkline" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={settings.notify_runs} onChange={(e) => save.mutate({ notify_runs: e.target.checked })} /><span>Kabari juga saat proses setup selesai atau gagal</span>
      </label>
    </>
  );
}

export function ChannelsPanel() {
  const channels = useQuery(q.channels()), history = useQuery(q.notifications()), settings = useQuery(q.settings()), [adding, setAdding] = useState(false);
  return (
    <Section title="Notifikasi ke Anda" icon={IconBell}>
      <Note>Dikirim saat peringatan kritis muncul, saat pulih, sebagai pengingat bila belum dilihat, dan saat agen meminta persetujuan perintah. Setiap kanal punya level minimum sendiri.</Note>
      <div className="row" style={{ marginTop: 12 }}><Button primary icon={IconPlus} onClick={() => setAdding(true)}>Tambah kanal</Button></div>
      <div style={{ marginTop: 12 }}>
        <div>
          <Async query={channels}>{(rows) => rows.length ? <List>{rows.map((c) => <ChannelRow key={c.id} c={c} />)}</List> : <Empty>Belum ada kanal. Tanpa kanal, peringatan hanya terlihat di halaman ini.</Empty>}</Async>
          {settings.data && <Preferences settings={settings.data} />}
        </div>
      </div>
      <Modal open={adding} onClose={() => setAdding(false)}><NewChannelForm onDone={() => setAdding(false)} /></Modal>
      <div style={{ marginTop: 14 }}>
        <h3 style={{ marginBottom: 8 }}>Riwayat pengiriman</h3>
        <Async query={history}>{(rows) => (
          <DataTable textCols={5} heads={['waktu', 'kanal', 'jenis', 'pesan', 'hasil']} empty="Belum ada pengiriman."
            rows={rows.slice(0, 10).map((n) => [dateTime(n.ts), n.channel_name, n.kind, n.title, n.ok ? 'terkirim' : `GAGAL: ${n.error}`])} />
        )}</Async>
      </div>
    </Section>
  );
}

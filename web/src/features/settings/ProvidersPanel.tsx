// Penyedia model + API key (dienkripsi di server; key lengkap tidak pernah ditampilkan).
import { useState } from 'react';
import { useAction } from '@/api/queries';
import type { AppConfig, Provider } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, useForm } from '@/components/ui/Field';
import { Empty, Item, List } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconCheck, IconClose, IconList, IconOk, IconPlus, IconTrash, IconWrench } from '@/components/icons';
import { del, post } from '@/lib/api';
import { toast } from '@/lib/toast';

const BLANK = { id: '', label: '', type: 'openai', baseUrl: '', apiKey: '' };
const API_TYPES: Array<[string, string]> = [['openai', 'OpenAI-kompatibel'], ['anthropic', 'Anthropic'], ['google', 'Google Gemini']];

function ProviderForm({ config, editing, onDone }: { config: AppConfig; editing: (Provider & { id: string }) | null; onDone: () => void }) {
  const { values, bind, set, reset } = useForm(editing ? { id: editing.id, label: editing.label, type: editing.type, baseUrl: editing.baseUrl, apiKey: '' } : BLANK);
  const preset = config.presets.find((p) => p.id === values.id);
  const save = useAction(
    () => post('/api/provider', { ...values, id: String(values.id).trim(), keyless: preset?.keyless ?? false }),
    { success: 'Penyedia disimpan', invalidate: [['config']], onSuccess: () => { reset(BLANK); onDone(); } }
  );
  const applyPreset = (id: string) => {
    const p = config.presets.find((x) => x.id === id);
    if (!p) return;
    set('id', p.id); set('label', p.label); set('type', p.type); set('baseUrl', p.baseUrl);
  };
  return (
    <form className="form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h2><IconPlus size={16} aria-hidden />{editing ? `Ubah ${editing.label}` : 'Tambah penyedia'}</h2>
      <Field label="Preset">
        <select aria-label="Preset penyedia" value="" onChange={(e) => applyPreset(e.target.value)}>
          <option value="">Kustom (isi manual)</option>{config.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </Field>
      <div className="cols tight">
        <Field label="ID"><input required maxLength={32} readOnly={!!editing} {...bind('id')} /></Field>
        <Field label="Nama tampilan"><input {...bind('label')} /></Field>
      </div>
      <div className="cols tight">
        <Field label="Jenis API"><select {...bind('type')}>{API_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Base URL"><input className="mono" {...bind('baseUrl')} /></Field>
      </div>
      <Field label={<>API key {editing?.hasKey && <em style={{ fontStyle: 'normal' }}>(kosongkan untuk mempertahankan {editing.keyHint})</em>}</>}>
        <input type="password" autoComplete="new-password" spellCheck={false} {...bind('apiKey')} />
      </Field>
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}><IconCheck size={16} aria-hidden />Simpan</button>
        <Button icon={IconClose} onClick={() => { reset(BLANK); onDone(); }}>Batal</Button>
      </div>
    </form>
  );
}

function ProviderRow({ id, p, onEdit }: { id: string; p: Provider; onEdit: () => void }) {
  const { confirm } = useDialogs();
  const models = useAction(() => post<{ models: string[] }>('/api/models', { id }), { onSuccess: (r) => toast(`${p.label}: terhubung, ${r.models.length} model`) });
  const remove = useAction(() => del(`/api/provider/${id}`), { invalidate: [['config']] });
  return (
    <Item title={p.label} sub={[`${id} | ${p.type} | ${p.baseUrl}`]}>
      {p.keyless ? <Badge tone="mute">tanpa key</Badge> : p.hasKey ? <Badge tone="ok" icon={IconOk}>{p.keyHint}</Badge> : <Badge tone="warn">key kosong</Badge>}
      <Button icon={IconList} title="Uji koneksi dan ambil daftar model" onClick={() => models.mutateAsync()}>Model</Button>
      <Button icon={IconWrench} aria-label={`Ubah ${p.label}`} onClick={onEdit} />
      <Button icon={IconTrash} aria-label={`Hapus ${p.label}`} onClick={async () => { if (await confirm(`Hapus penyedia ${p.label}?`, 'Hapus')) await remove.mutateAsync(); }} />
    </Item>
  );
}

/** Formulir ada di modal: `dialog` null = tertutup, '' = penyedia baru, selain itu = id yang diubah. */
export function ProvidersPanel({ config }: { config: AppConfig }) {
  const [dialog, setDialog] = useState<string | null>(null);
  const entries = Object.entries(config.providers), current = dialog ? config.providers[dialog] : undefined;
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}><Button primary icon={IconPlus} onClick={() => setDialog('')}>Tambah penyedia</Button></div>
      {entries.length ? <List>{entries.map(([id, p]) => <ProviderRow key={id} id={id} p={p} onEdit={() => setDialog(id)} />)}</List> : <Empty>Belum ada penyedia.</Empty>}
      <Modal open={dialog !== null} onClose={() => setDialog(null)}>
        <ProviderForm key={dialog || 'baru'} config={config} editing={dialog && current ? { ...current, id: dialog } : null} onDone={() => setDialog(null)} />
      </Modal>
      <p className="lbl" style={{ marginTop: 10 }}>Key dienkripsi (AES-256-GCM) dalam database lokal; kunci enkripsinya ada di berkas terpisah. Halaman ini tidak pernah menampilkan key lengkap.</p>
    </>
  );
}

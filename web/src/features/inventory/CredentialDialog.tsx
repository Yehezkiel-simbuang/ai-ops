// Formulir kredensial (baru/ubah) dengan pembuat password dan username otomatis.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { q, useAction } from '@/api/queries';
import type { Credential, CredentialInput, CredentialKind, CredentialSaved, GeneratedSecret } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Button } from '@/components/ui/Button';
import { Field, useForm } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { IconCheck, IconClose, IconKey, IconRefresh } from '@/components/icons';
import { post, put } from '@/lib/api';
import { dateInputToMs, dateStr } from '@/lib/format';

const KINDS: Array<[CredentialKind, string]> = [['ssh', 'SSH / login server'], ['password', 'Password lain'], ['database', 'Database'], ['web', 'Panel web'], ['api_key', 'API key / token'], ['ssh_key', 'Kunci SSH'], ['other', 'Lainnya']];

interface Props { open: boolean; onClose: () => void; serverId: number | null; credential?: Credential }

function Form({ serverId: fixedServerId, credential, onClose }: Omit<Props, 'open'>) {
  const pickable = fixedServerId === null && !credential, servers = useQuery({ ...q.servers(), enabled: pickable }), [picked, setPicked] = useState('');
  const serverId = fixedServerId ?? (picked ? Number(picked) : null);
  const { showSecret } = useDialogs();
  const { values, bind, bindCheck, set } = useForm({
    label: credential?.label ?? '', kind: credential?.kind ?? 'ssh', username: credential?.username ?? '', secret: '', url: credential?.url ?? '', port: credential?.port ?? '',
    notes: credential?.notes ?? '', rot: credential?.rotate_every_days ?? '', exp: credential?.expires_at ? dateStr(credential.expires_at) : '',
    length: 24, symbols: true, avoidAmbiguous: true
  });
  const [revealText, setRevealText] = useState(false);
  const generator = { length: Number(values.length), symbols: Boolean(values.symbols), avoidAmbiguous: Boolean(values.avoidAmbiguous) };
  const invalidate = [['vault'], ['servers', serverId ?? 0, 'credentials'], ['inventory'], ['overview']];

  const generate = useAction(() => post<GeneratedSecret>('/api/vault/generate', generator), { onSuccess: (r) => { set('secret', r.password); setRevealText(true); } });
  const generateUser = useAction(() => post<GeneratedSecret>('/api/vault/generate', { username_prefix: values.label || 'svc' }), { onSuccess: (r) => set('username', r.username) });
  const save = useAction(async () => {
    const body: CredentialInput = {
      label: String(values.label), kind: values.kind as CredentialKind, username: String(values.username), url: String(values.url), port: values.port === '' ? null : Number(values.port), notes: String(values.notes),
      rotate_every_days: values.rot === '' ? null : Number(values.rot), expires_at: values.exp ? (dateInputToMs(String(values.exp), '23:59:59') ?? null) : null
    };
    if (values.secret) body.secret = String(values.secret); else if (!credential) body.generate = generator;
    if (credential) return put<CredentialSaved>(`/api/credentials/${credential.id}`, body);
    return post<CredentialSaved>(serverId ? `/api/servers/${serverId}/credentials` : '/api/vault', body);
  }, {
    success: (r) => (r.generated ? null : 'Kredensial disimpan'), invalidate,
    onSuccess: (r) => {
      onClose();
      if (r.generated) showSecret(`Password dibuat: ${values.label}`, 'Salin sekarang dan terapkan di server/layanan. Setelah ditutup, password hanya bisa dilihat lewat "Ungkap" dengan konfirmasi.', r.generated);
    }
  });

  return (
    <form className="form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h2><IconKey size={16} aria-hidden />{credential ? 'Ubah kredensial' : 'Kredensial baru'}</h2>
      {pickable && (
        <Field label="Server (opsional)"><select aria-label="Server" value={picked} onChange={(e) => setPicked(e.target.value)}>
          <option value="">Umum (tidak terikat ke server)</option>{servers.data?.map((sv) => <option key={sv.id} value={sv.id}>{sv.name} ({sv.host})</option>)}
        </select></Field>
      )}
      <Field label="Label"><input required placeholder="mis. root SSH, MySQL root, panel admin" {...bind('label')} /></Field>
      <Field label="Jenis"><select {...bind('kind')}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <div className="cols tight" style={{ alignItems: 'end' }}>
        <Field label="Username"><input autoComplete="off" {...bind('username')} /></Field>
        <Button icon={IconRefresh} onClick={() => generateUser.mutateAsync()}>Buat username</Button>
      </div>
      <Field label={credential ? 'Password baru (opsional)' : 'Password'}>
        <input type={revealText ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} placeholder={credential ? '(kosong = tidak diubah)' : 'tempel atau buat otomatis'} {...bind('secret')} />
      </Field>
      <div className="row">
        <Button icon={IconKey} onClick={() => generate.mutateAsync()}>Buat password otomatis</Button>
        <label className="checkline"><input type="number" min={8} max={128} className="input-md" aria-label="Panjang password" {...bind('length')} /><span>karakter</span></label>
        <label className="checkline"><input type="checkbox" {...bindCheck('symbols')} /><span>simbol</span></label>
        <label className="checkline"><input type="checkbox" {...bindCheck('avoidAmbiguous')} /><span>hindari karakter mirip (0/O, 1/l)</span></label>
      </div>
      <div className="cols tight"><Field label="URL"><input placeholder="https://... (opsional)" {...bind('url')} /></Field><Field label="Port"><input type="number" min={1} max={65535} {...bind('port')} /></Field></div>
      <Field label="Catatan"><input {...bind('notes')} /></Field>
      <div className="cols tight">
        <Field label="Ingatkan ganti password tiap (hari)"><input type="number" min={1} max={3650} placeholder="hari, mis. 90" {...bind('rot')} /></Field>
        <Field label="Kedaluwarsa pada"><input type="date" {...bind('exp')} /></Field>
      </div>
      <div className="row"><button type="submit" className="primary" disabled={save.isPending}><IconCheck size={16} aria-hidden />Simpan</button><Button icon={IconClose} onClick={onClose}>Batal</Button></div>
    </form>
  );
}

export function CredentialDialog({ open, onClose, serverId, credential }: Props) {
  return <Modal open={open} onClose={onClose}><Form serverId={serverId} credential={credential} onClose={onClose} /></Modal>;
}

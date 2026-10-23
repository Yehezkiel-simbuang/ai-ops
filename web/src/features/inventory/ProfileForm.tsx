// Formulir dokumentasi server: fungsi, pemilik, tag, alamat, layanan, ketergantungan, runbook.
import { useState } from 'react';
import { useAction } from '@/api/queries';
import type { Address, Dependency, Environment, ProfileInput, Server, ServerProfile, ServiceDoc } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, useForm } from '@/components/ui/Field';
import { IconLayers, IconNetwork, IconPlus, IconSplit, IconTrash } from '@/components/icons';
import { put } from '@/lib/api';

const ENVIRONMENTS: Environment[] = ['prod', 'staging', 'dev', 'lab', 'other'];

/** Perbarui satu elemen array state tanpa mengubah aslinya. */
const patchAt = <T,>(list: T[], i: number, patch: Partial<T>): T[] => list.map((x, j) => (j === i ? { ...x, ...patch } : x));

function AddressRows({ items, onChange }: { items: Address[]; onChange: (next: Address[]) => void }) {
  return (
    <div className="form">
      {items.map((a, i) => (
        <div className="row" key={i}>
          <input placeholder="label" aria-label="Label alamat" value={a.label ?? ''} onChange={(e) => onChange(patchAt(items, i, { label: e.target.value }))} />
          <input className="mono" placeholder="IP / hostname" aria-label="Alamat" value={a.address ?? ''} onChange={(e) => onChange(patchAt(items, i, { address: e.target.value, kind: undefined }))} />
          <label className="checkline"><input type="checkbox" checked={!!a.is_primary} aria-label="utama" onChange={(e) => onChange(items.map((x, j) => ({ ...x, is_primary: j === i ? e.target.checked : false })))} /><span>utama</span></label>
          <Button icon={IconTrash} aria-label="Hapus alamat" onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Button icon={IconPlus} onClick={() => onChange([...items, { label: '', address: '', is_primary: false, notes: '' }])}>Tambah alamat</Button></div>
    </div>
  );
}

function ServiceRows({ items, onChange }: { items: ServiceDoc[]; onChange: (next: ServiceDoc[]) => void }) {
  return (
    <div className="form">
      {items.map((v, i) => (
        <div className="row" key={i}>
          <input placeholder="nama (MySQL)" aria-label="Nama layanan" value={v.name ?? ''} onChange={(e) => onChange(patchAt(items, i, { name: e.target.value }))} />
          <input type="number" placeholder="port" aria-label="Port layanan" style={{ width: 100 }} value={v.port ?? ''} onChange={(e) => onChange(patchAt(items, i, { port: e.target.value === '' ? null : Number(e.target.value) }))} />
          <input placeholder="catatan" aria-label="Catatan layanan" value={v.notes ?? ''} onChange={(e) => onChange(patchAt(items, i, { notes: e.target.value }))} />
          <Button icon={IconTrash} aria-label="Hapus layanan" onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Button icon={IconPlus} onClick={() => onChange([...items, { name: '', port: null, protocol: 'tcp', url: '', notes: '' }])}>Tambah layanan</Button></div>
    </div>
  );
}

function DependencyRows({ items, onChange, servers, selfId }: { items: Dependency[]; onChange: (next: Dependency[]) => void; servers: Server[]; selfId: number }) {
  const available = servers.filter((s) => s.id !== selfId && !items.some((d) => d.id === s.id));
  return (
    <div className="form">
      {items.map((d, i) => (
        <div className="row" key={d.id}>
          <b>{servers.find((s) => s.id === d.id)?.name ?? d.id}</b>
          <input placeholder="catatan (mis. dipakai untuk login pengguna)" aria-label="Catatan dependensi" value={d.note ?? ''} onChange={(e) => onChange(patchAt(items, i, { note: e.target.value }))} />
          <Button icon={IconTrash} aria-label="Hapus dependensi" onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      ))}
      <select aria-label="Tambah dependensi" value="" onChange={(e) => { if (e.target.value) onChange([...items, { id: Number(e.target.value), note: '' }]); }} style={{ width: 'auto' }}>
        <option value="">+ bergantung pada server...</option>{available.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  );
}

export function ProfileForm({ profile, servers, onSaved }: { profile: ServerProfile; servers: Server[]; onSaved: () => void }) {
  const s = profile.server;
  const { values, bind } = useForm({ purpose: s.purpose ?? '', owner: s.owner ?? '', location: s.location ?? '', tags: (s.tags ?? []).join(', '), environment: s.environment, runbook: s.runbook ?? '' });
  const [addresses, setAddresses] = useState<Address[]>(profile.addresses), [services, setServices] = useState<ServiceDoc[]>(profile.services);
  const [deps, setDeps] = useState<Dependency[]>(profile.depends.map((d) => ({ id: d.id, note: d.note })));
  const save = useAction(() => put(`/api/servers/${s.id}/profile`, {
    purpose: values.purpose, owner: values.owner, location: values.location, environment: values.environment as Environment, runbook: values.runbook,
    tags: String(values.tags).split(',').map((t) => t.trim()).filter(Boolean),
    addresses: addresses.filter((a) => (a.address ?? '').trim()), services: services.filter((v) => (v.name ?? '').trim()), dependsOn: deps.map((d) => ({ id: d.id, note: d.note }))
  } satisfies ProfileInput), { success: 'Dokumentasi disimpan', invalidate: [['servers', s.id, 'profile'], ['inventory']], onSuccess: onSaved });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Field label="Fungsi server"><input placeholder="Server ini untuk apa?" {...bind('purpose')} /></Field>
      <div className="cols tight"><Field label="Pemilik / penanggung jawab"><input placeholder="siapa yang bertanggung jawab" {...bind('owner')} /></Field><Field label="Lokasi"><input placeholder="mis. Rak 2, ruang server lantai 3, atau region cloud" {...bind('location')} /></Field></div>
      <div className="cols tight">
        <Field label="Tag (pisah koma)"><input placeholder="database, postgres, produksi" {...bind('tags')} /></Field>
        <Field label="Lingkungan"><select {...bind('environment')}>{ENVIRONMENTS.map((e) => <option key={e}>{e}</option>)}</select></Field>
      </div>
      <h2><IconNetwork size={16} aria-hidden />Alamat</h2><AddressRows items={addresses} onChange={setAddresses} />
      <h2><IconLayers size={16} aria-hidden />Layanan</h2><ServiceRows items={services} onChange={setServices} />
      <h2><IconSplit size={16} aria-hidden />Bergantung pada</h2><DependencyRows items={deps} onChange={setDeps} servers={servers} selfId={s.id} />
      <Field label="Catatan / runbook (teks bebas atau Markdown)" hint="Cara restart yang aman, jam sibuk, kontak vendor, hal yang tidak boleh disentuh."><textarea className="mono" style={{ minHeight: 140, fontSize: '.8rem' }} {...bind('runbook')} /></Field>
      <div className="row"><button type="submit" className="primary" disabled={save.isPending}>Simpan dokumentasi</button></div>
    </form>
  );
}

// Model per peran: tiap peran (Setup, Monitoring) bisa memakai penyedia dan model berbeda.
import { useState } from 'react';
import { useAction } from '@/api/queries';
import type { AppConfig, RoleTest } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { IconBolt, IconCheck, IconEye, IconWrench, type IconType } from '@/components/icons';
import { post } from '@/lib/api';

const ROLES: Array<{ id: string; label: string; icon: IconType; hint: string }> = [
  { id: 'setup', label: 'Setup server', icon: IconWrench, hint: 'Diagnosis, perencanaan, dan penerapan perubahan.' },
  { id: 'monitor', label: 'Monitoring', icon: IconEye, hint: 'Analisis metrik dan ringkasan kondisi.' }
];

function RoleCard({ role, config }: { role: (typeof ROLES)[number]; config: AppConfig }) {
  const current = config.roles[role.id], providers = Object.entries(config.providers);
  const [provider, setProvider] = useState(current?.provider ?? ''), [model, setModel] = useState(current?.model ?? '');
  const [models, setModels] = useState<string[]>([]), [result, setResult] = useState('');
  const save = useAction(() => post('/api/role', { role: role.id, provider, model }), { success: `Peran ${role.label} disimpan`, invalidate: [['config'], ['overview']] });
  const fetchModels = useAction((id: string) => post<{ models: string[] }>('/api/models', { id }), { onSuccess: (r) => setModels(r.models) });
  const test = useAction(() => { setResult('Memanggil model...'); return post<RoleTest>('/api/test', { role: role.id }); }, {
    onSuccess: (r) => setResult(`Balasan: "${r.text.trim()}" | ${r.usage.input} masuk, ${r.usage.output} keluar | ${r.ms} ms`)
  });
  const Icon = role.icon;
  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 8 }}><b><Icon size={16} aria-hidden /> {role.label}</b><span className="lbl">{role.hint}</span></div>
      <div className="cols tight">
        <Field label="Penyedia">
          <select aria-label={`Penyedia ${role.label}`} value={provider} onChange={(e) => { setProvider(e.target.value); if (e.target.value) fetchModels.mutate(e.target.value); }}>
            <option value="">{providers.length ? 'Pilih penyedia' : 'Tambahkan penyedia dulu'}</option>
            {providers.map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Model">
          <input className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="nama model" list={`models-${role.id}`} aria-label={`Model ${role.label}`} />
          <datalist id={`models-${role.id}`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
        </Field>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <Button primary icon={IconCheck} onClick={() => save.mutateAsync()}>Simpan</Button>
        <Button icon={IconBolt} onClick={() => test.mutateAsync()}>Uji panggilan</Button>
      </div>
      {result && <div className="note">{result}</div>}
    </div>
  );
}

export function RolesPanel({ config }: { config: AppConfig }) {
  return <div className="form">{ROLES.map((r) => <RoleCard key={r.id} role={r} config={config} />)}</div>;
}

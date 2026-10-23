// Palet komponen: kartu tiap blok bangunan (Redis, load balancer, replika, ...) dengan parameter yang bisa diatur, lalu dipasang ke eksperimen.
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconBolt, IconCheck, IconDatabase, IconDisk, IconFilter, IconGauge, IconGlobe, IconList, IconPlus, IconReplica, IconShield, IconSplit, IconTrash, type IconType } from '@/components/icons';
import { componentKey, defaultParams } from './scenario';
import type { LabAction, LabComponent, LabParam, ParamValue } from './types';

const ICONS: Record<string, IconType> = { cache: IconBolt, lb: IconSplit, filter: IconFilter, replica: IconReplica, ha: IconShield, dbsplit: IconDatabase, queue: IconList, scale: IconGauge, disk: IconDisk, cdn: IconGlobe };
type Values = Record<string, ParamValue>;

function ParamField({ p, value, onChange }: { p: LabParam; value: ParamValue; onChange: (v: ParamValue) => void }) {
  const id = `p-${p.key}`;
  if (p.type === 'select') {
    return <label className="param"><span>{p.label}</span><select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>{p.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
  }
  if (p.type === 'bool') return <label className="checkline"><input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /><span>{p.label}</span></label>;
  return (
    <label className="param">
      <span>{p.label}</span>
      <span className="row2">
        <input type="range" min={p.min} max={p.max} step={p.step} value={Number(value)} aria-label={p.label} onChange={(e) => onChange(Number(e.target.value))} />
        <output>{Number(value)}{p.unit}</output>
      </span>
    </label>
  );
}

interface CardProps { c: LabComponent; installed: LabAction | undefined; onApply: (params: Values) => void; onRemove: (key: string) => void }

function ComponentCard({ c, installed, onApply, onRemove }: CardProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Values>(() => (installed?.kind === 'component' ? installed.params : defaultParams(c.params)));
  const Icon = ICONS[c.icon] ?? IconBolt, on = !!installed;
  const key = componentKey(c.id, draft);
  const apply = () => { onApply(draft); setOpen(false); };
  return (
    <div className={`card-comp${on ? ' on' : ''}`} aria-disabled={!c.available}>
      <header onClick={() => c.available && setOpen((o) => !o)} role="button" tabIndex={0} aria-expanded={open} onKeyDown={(e) => { if (c.available && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen((o) => !o); } }}>
        <Icon size={17} aria-hidden /><b>{c.label}</b>
        {on && <span className="badge ok"><IconCheck size={12} aria-hidden />terpasang</span>}
        {!c.available && <span className="badge mute">tidak berlaku</span>}
      </header>
      {!c.available && <div className="body"><p>{c.reason}</p></div>}
      {c.available && open && (
        <div className="body">
          <p>{c.summary}</p>
          {c.params.map((p) => <ParamField key={p.key} p={p} value={draft[p.key] ?? p.default} onChange={(v) => setDraft((d) => ({ ...d, [p.key]: v }))} />)}
          <details><summary>Asumsi model</summary><div className="body"><p>{c.assumptions}</p></div></details>
          <div className="row">
            <Button primary icon={on ? IconCheck : IconPlus} onClick={apply}>{on ? 'Perbarui' : 'Pasang'}</Button>
            {on && <Button icon={IconTrash} onClick={() => onRemove(key)}>Lepas</Button>}
          </div>
        </div>
      )}
      {c.available && !open && <div className="body"><p>{c.summary}</p></div>}
    </div>
  );
}

interface PaletteProps { catalog: LabComponent[]; actions: LabAction[]; onApply: (component: LabComponent['id'], params: Values) => void; onRemove: (key: string) => void }

export function Palette({ catalog, actions, onApply, onRemove }: PaletteProps) {
  return (
    <div className="stack" aria-label="Komponen yang bisa ditambahkan">
      {catalog.map((c) => {
        // komponen yang sudah terpasang (target pertama yang cocok), supaya kartu menampilkan parameternya
        const installed = actions.find((a) => a.kind === 'component' && a.component === c.id);
        return <ComponentCard key={`${c.id}:${installed ? JSON.stringify(installed) : ''}`} c={c} installed={installed} onApply={(p) => onApply(c.id, p)} onRemove={onRemove} />;
      })}
    </div>
  );
}

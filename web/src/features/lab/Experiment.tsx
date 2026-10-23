// Daftar aksi eksperimen (apa saja yang sedang diterapkan) dan rekomendasi awal yang bisa dihidupkan/dimatikan.
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Empty, Item, List, Note } from '@/components/ui/Layout';
import { IconClose, IconTrash } from '@/components/icons';
import { actionKeyOf } from './scenario';
import type { LabAction, LabComponent, LabParam, LabRec, ParamValue } from './types';

const SEVERITY: Record<LabRec['severity'], Tone> = { tinggi: 'bad', sedang: 'warn', rendah: 'mute' };

function paramText(p: LabParam, v: ParamValue): string {
  if (p.type === 'select') return p.options?.find((o) => o.value === v)?.label ?? String(v);
  if (p.type === 'bool') return v ? p.label : '';
  return `${v}${p.unit ?? ''}`;
}

export function AppliedActions({ actions, catalog, recs, onRemove, onClear }: { actions: LabAction[]; catalog: LabComponent[]; recs: LabRec[]; onRemove: (key: string) => void; onClear: () => void }) {
  if (!actions.length) return <Empty>Belum ada perubahan. Ini sama dengan kondisi sekarang.</Empty>;
  return (
    <>
      <List>{actions.map((a) => {
        const key = actionKeyOf(a);
        if (a.kind === 'rec') return <Item key={key} title={recs.find((r) => r.id === a.id)?.title ?? a.id} sub={['Rekomendasi']}><Button icon={IconClose} aria-label="Lepas rekomendasi" onClick={() => onRemove(key)} /></Item>;
        const c = catalog.find((x) => x.id === a.component);
        const summary = (c?.params ?? []).map((p) => paramText(p, a.params[p.key] ?? p.default)).filter(Boolean).join(' · ');
        return <Item key={key} title={c?.label ?? a.component} sub={[summary]}><Button icon={IconClose} aria-label={`Lepas ${c?.label ?? a.component}`} onClick={() => onRemove(key)} /></Item>;
      })}</List>
      <div style={{ marginTop: 8 }}><Button icon={IconTrash} onClick={onClear}>Kosongkan semua</Button></div>
    </>
  );
}

export function Recommendations({ recs, actions, onToggle }: { recs: LabRec[]; actions: LabAction[]; onToggle: (id: string) => void }) {
  if (!recs.length) return <Empty>Tidak ada rekomendasi untuk arsitektur ini.</Empty>;
  return (
    <div className="stack">
      <Note>Dihitung dari model arsitektur proyek ini. Centang untuk memasukkan ke eksperimen dan lihat dampaknya.</Note>
      {recs.map((r) => {
        const on = actions.some((a) => a.kind === 'rec' && a.id === r.id);
        return (
          <details key={r.id}>
            <summary>
              <label className="checkline" style={{ display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={on} onChange={() => onToggle(r.id)} aria-label={`Terapkan: ${r.title}`} />
              </label>{' '}
              {r.title} <Badge tone={SEVERITY[r.severity]}>{r.severity}</Badge>{r.optional && <> <Badge>opsional</Badge></>}
            </summary>
            <div className="body">
              {r.why.length > 0 && <ul className="lbl" style={{ margin: 0, paddingLeft: '1.1em' }}>{r.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}
              {r.expected && <p className="note"><b>Harapan:</b> {r.expected}</p>}
              {r.tradeoff && <p className="note"><b>Harga:</b> {r.tradeoff}</p>}
            </div>
          </details>
        );
      })}
    </div>
  );
}

// Pemeriksaan layanan di dalam server (read-only lewat SSH): daftar, deteksi paket, tambah manual.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { q, useAction } from '@/api/queries';
import type { Check, ChecksMeta, DiscoverResult, NewCheck, PackMeta } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, useForm } from '@/components/ui/Field';
import { Link } from 'react-router-dom';
import { Empty, Item, List } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { FIELD_LABELS } from './fieldLabels';
import { EditCommand, ServicesPanel } from './ServicesPanel';
import { IconAlert, IconBad, IconBulb, IconCheck, IconEye, IconList, IconOk, IconWrench, IconPlus, IconTimer, IconTrash, type IconType } from '@/components/icons';
import { del, post, put } from '@/lib/api';
import { ago } from '@/lib/format';
import { toast } from '@/lib/toast';

const STATUS: Record<string, [Tone, IconType, string]> = {
  ok: ['ok', IconOk, 'Normal'], warn: ['warn', IconAlert, 'Peringatan'], crit: ['bad', IconBad, 'Kritis'], unknown: ['mute', IconAlert, 'Tidak terbaca'], belum: ['mute', IconTimer, 'Belum dijalankan']
};
/** Tipe pemeriksaan yang menghasilkan angka (punya ambang peringatan/kritis). */
const isNumeric = (type: string) => (type.includes('_') && !/ping|conf|health|running|sync|alarms/.test(type)) || ['http', 'proc_count', 'custom'].includes(type);

function CheckRow({ c, serverId }: { c: Check; serverId: number }) {
  const { confirm } = useDialogs(), [editing, setEditing] = useState(false);
  const [warn, setWarn] = useState(c.warn == null ? '' : String(c.warn)), [crit, setCrit] = useState(c.crit == null ? '' : String(c.crit));
  const invalidate = [['servers', serverId, 'monitor']];
  const update = useAction((patch: Record<string, unknown>) => put(`/api/checks/${c.id}`, patch), { invalidate });
  const remove = useAction(() => del(`/api/checks/${c.id}`), { invalidate });
  const [tone, Icon, label] = STATUS[c.last_status ?? 'belum'] ?? STATUS.belum!;
  const numeric = isNumeric(c.type);
  const saveThresholds = () => update.mutate({ warn, crit }, { onSuccess: () => toast('Ambang disimpan') });
  return (
    <Item off={!c.enabled} title={c.name} sub={[`${c.last_detail || (c.last_run ? 'normal' : 'belum dijalankan')}${c.last_run ? ` | ${ago(c.last_run)}` : ''}`]}>
      {numeric && c.last_value != null && <span className="mono lbl">{Math.round(c.last_value * 100) / 100}</span>}
      <Badge tone={tone} icon={Icon}>{label}</Badge>
      {numeric && c.std_source !== 'sendiri' && (c.warn != null || c.crit != null) && <Link className="lbl" to="/standar" title="Diatur di Standar pemantauan, berlaku untuk semua server">ambang {c.warn ?? '-'} / {c.crit ?? '-'}</Link>}
      {numeric && c.std_source === 'sendiri' && (
        <span className="row" style={{ gap: 4 }}>
          <input type="number" step="any" className="input-sm" placeholder="warn" aria-label="Ambang peringatan" value={warn} onChange={(e) => setWarn(e.target.value)} onBlur={saveThresholds} />
          <input type="number" step="any" className="input-sm" placeholder="kritis" aria-label="Ambang kritis" value={crit} onChange={(e) => setCrit(e.target.value)} onBlur={saveThresholds} />
        </span>
      )}
      <label className="checkline" title="Aktifkan"><input type="checkbox" checked={c.enabled} aria-label={`Aktif ${c.name}`} onChange={(e) => update.mutate({ enabled: e.target.checked })} /></label>
      {c.type === 'custom' && <Button icon={IconWrench} aria-label={`Ubah perintah ${c.name}`} onClick={() => setEditing(true)} />}
      <Button icon={IconTrash} aria-label={`Hapus ${c.name}`} onClick={async () => { if (await confirm(`Hapus pemeriksaan "${c.name}"?`, 'Hapus')) await remove.mutateAsync(); }} />
      <Modal open={editing} onClose={() => setEditing(false)}><EditCommand serverId={serverId} checkId={c.id} params={(c.params ?? {}) as Record<string, unknown>} warn={c.warn} crit={c.crit} onDone={() => setEditing(false)} /></Modal>
    </Item>
  );
}

function PackRow({ pack, detected, state }: { pack: PackMeta; detected: boolean; state: PackState }) {
  const sel = state.selected[pack.id] ?? false, opts = state.opts[pack.id] ?? {};
  return (
    <div className="item top">
      <label className="checkline">
        <input type="checkbox" checked={sel} onChange={(e) => state.setSelected(pack.id, e.target.checked)} />
        <span><b>{pack.label}</b>{detected && <span className="badge ok" style={{ marginLeft: 8 }}>terdeteksi</span>}{pack.hint && <div className="lbl">{pack.hint}</div>}</span>
      </label>
      {pack.fields.length > 0 && (
        <div style={{ flex: '1 1 320px', display: 'grid', gap: 6 }}>
          {pack.fields.map((f) => <Field key={f.k} label={f.label}><input className="mono" value={opts[f.k] ?? ''} onChange={(e) => state.setOpt(pack.id, f.k, e.target.value)} /></Field>)}
        </div>
      )}
    </div>
  );
}

interface PackState { selected: Record<string, boolean>; opts: Record<string, Record<string, string>>; setSelected: (id: string, v: boolean) => void; setOpt: (id: string, k: string, v: string) => void }

function DiscoverPanel({ serverId, meta, found, onClose }: { serverId: number; meta: ChecksMeta; found: DiscoverResult; onClose: () => void }) {
  const [selected, setSel] = useState<Record<string, boolean>>(() => Object.fromEntries(meta.packs.map((p) => [p.id, p.id === 'host' || !!found[p.id]])));
  const [opts, setOpts] = useState<Record<string, Record<string, string>>>(() => Object.fromEntries(meta.packs.map((p) => [p.id, Object.fromEntries(p.fields.map((f) => [f.k, found[p.id]?.opts?.[f.k] || f.def || '']))])));
  const state: PackState = {
    selected, opts,
    setSelected: (id, v) => setSel((s) => ({ ...s, [id]: v })),
    setOpt: (id, k, v) => setOpts((o) => ({ ...o, [id]: { ...o[id], [k]: v } }))
  };
  const detected = meta.packs.filter((p) => p.id === 'host' || !!found[p.id]), others = meta.packs.filter((p) => !(p.id === 'host' || !!found[p.id]));   // yang terdeteksi di atas; sisanya (mis. Laravel) dilipat
  const apply = useAction(async () => {
    let added = 0;
    for (const pack of meta.packs.filter((p) => selected[p.id])) {
      const cleaned = Object.fromEntries(Object.entries(opts[pack.id] ?? {}).map(([k, v]) => [k, v.trim()]));
      added += (await post<{ added: unknown[] }>(`/api/servers/${serverId}/packs`, { pack: pack.id, opts: cleaned })).added.length;
    }
    return added;
  }, { success: (n) => `${n} pemeriksaan ditambahkan`, invalidate: [['servers', serverId, 'monitor']], onSuccess: onClose });
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <h2><IconBulb size={16} aria-hidden />Paket yang disarankan</h2>
      <List>{detected.map((p) => <PackRow key={p.id} pack={p} detected state={state} />)}</List>
      {others.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary>Paket lain yang tersedia ({others.length}): tidak terdeteksi di server ini</summary>
          <div className="body"><List>{others.map((p) => <PackRow key={p.id} pack={p} detected={false} state={state} />)}</List></div>
        </details>
      )}
      <div className="row" style={{ marginTop: 10 }}><Button primary icon={IconCheck} onClick={() => apply.mutateAsync()}>Terapkan paket terpilih</Button><Button onClick={onClose}>Tutup</Button></div>
    </div>
  );
}

const NEW_CHECK = { name: '', type: '', warn: '', crit: '', dir: 'gt', delta: false, confirm: 2 };

function AddCheckPanel({ serverId, meta, onClose }: { serverId: number; meta: ChecksMeta; onClose: () => void }) {
  const { values, bind, bindCheck, set } = useForm({ ...NEW_CHECK, type: meta.types[0]?.id ?? '' });
  const fields = meta.types.find((t) => t.id === values.type)?.fields ?? [];
  const [params, setParams] = useState<Record<string, string>>({});
  const save = useAction(
    () => post(`/api/servers/${serverId}/checks`, { ...values, params: { ...Object.fromEntries(fields.map((f) => [f, f === 'sec' ? '10' : ''])), ...params }, confirm: Number(values.confirm) } as NewCheck),
    { success: 'Pemeriksaan ditambahkan', invalidate: [['servers', serverId, 'monitor']], onSuccess: onClose }
  );
  return (
    <div className="panel form" style={{ marginBottom: 12 }}>
      <h2><IconPlus size={16} aria-hidden />Pemeriksaan baru</h2>
      <Field label="Tipe">
        <select aria-label="Tipe pemeriksaan" value={values.type} onChange={(e) => { set('type', e.target.value); setParams({}); }}>{meta.types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
      </Field>
      <Field label="Nama"><input placeholder="mis. MySQL: query lambat" {...bind('name')} /></Field>
      {fields.map((f) => (
        <Field key={f} label={FIELD_LABELS[f] ?? f}><input className="mono" value={params[f] ?? (f === 'sec' ? '10' : '')} onChange={(e) => setParams((p) => ({ ...p, [f]: e.target.value }))} /></Field>
      ))}
      <div className="cols tight"><Field label="Ambang peringatan"><input type="number" step="any" {...bind('warn')} /></Field><Field label="Ambang kritis"><input type="number" step="any" {...bind('crit')} /></Field></div>
      <Field label="Arah"><select {...bind('dir')}><option value="gt">Bahaya bila nilai NAIK melewati ambang</option><option value="lt">Bahaya bila nilai TURUN di bawah ambang</option></select></Field>
      <label className="checkline"><input type="checkbox" {...bindCheck('delta')} /><span>Pakai selisih sejak pemeriksaan lalu (untuk penghitung yang terus naik, mis. galat di log)</span></label>
      <Field label="Konfirmasi (gagal berturut-turut sebelum peringatan)"><input type="number" min={1} max={10} {...bind('confirm')} /></Field>
      <div className="row"><Button primary icon={IconCheck} onClick={() => save.mutateAsync()}>Simpan</Button><Button onClick={onClose}>Tutup</Button></div>
    </div>
  );
}

const SEVERITY: Record<string, number> = { crit: 4, warn: 3, unknown: 2, ok: 1, belum: 0 };

/** Kelompok pemeriksaan menurut paket (kolom pack, atau awalan nama sebelum titik dua). Urutan kemunculan dipertahankan. */
export function groupChecks(checks: Check[], packs: PackMeta[] = []): Array<{ key: string; label: string; checks: Check[]; worst: string }> {
  const groups = new Map<string, Check[]>();
  for (const c of checks) { const key = c.pack || c.name.split(':')[0]!.trim() || 'Lainnya'; groups.set(key, [...(groups.get(key) ?? []), c]); }
  return [...groups].map(([key, list]) => ({
    key, label: packs.find((p) => p.id === key)?.label ?? key, checks: list,
    worst: list.filter((c) => c.enabled).map((c) => c.last_status ?? 'belum').sort((a, b) => (SEVERITY[b] ?? 0) - (SEVERITY[a] ?? 0))[0] ?? 'belum'
  }));
}

function CheckGroup({ label, checks, worst, serverId, open }: { label: string; checks: Check[]; worst: string; serverId: number; open: boolean }) {
  const invalidate = [['servers', serverId, 'monitor']], enabled = checks.filter((c) => c.enabled).length;
  const setAll = useAction((on: boolean) => Promise.all(checks.map((c) => put(`/api/checks/${c.id}`, { enabled: on }))), { invalidate });
  const { confirm } = useDialogs(), removeAll = useAction(() => Promise.all(checks.map((c) => del(`/api/checks/${c.id}`))), { invalidate });
  const [tone, Icon, text] = STATUS[enabled ? worst : 'belum'] ?? STATUS.belum!;
  const count = (s: string) => checks.filter((c) => c.enabled && (c.last_status ?? 'belum') === s).length;
  return (
    <details className="group" open={open}>
      <summary>
        <b>{label}</b><span className="lbl">{checks.length} pemeriksaan{enabled < checks.length ? `, ${checks.length - enabled} mati` : ''}</span>
        <span className="grow" />
        {count('crit') > 0 && <Badge tone="bad">{count('crit')} kritis</Badge>}{count('warn') > 0 && <Badge tone="warn">{count('warn')} peringatan</Badge>}
        {enabled === 0 ? <Badge tone="mute">dimatikan</Badge> : <Badge tone={tone} icon={Icon}>{text}</Badge>}
        <Button icon={IconTrash} aria-label={`Hapus kelompok ${label}`} title="Hapus seluruh kelompok" onClick={async (e) => { e.preventDefault(); e.stopPropagation(); if (await confirm(`Hapus seluruh kelompok "${label}" (${checks.length} pemeriksaan) beserta riwayatnya? Bisa ditambahkan lagi lewat Deteksi paket.`, 'Hapus semuanya')) await removeAll.mutateAsync(); }} />
      </summary>
      <div className="row" style={{ margin: '8px 0' }}>
        <Button onClick={() => setAll.mutateAsync(enabled === 0)}>{enabled === 0 ? 'Aktifkan semua' : 'Matikan semua'}</Button>
        <span className="lbl">Matikan kelompok yang tidak dipakai di server ini (mis. layanan yang memang tidak terpasang) agar tidak menimbulkan peringatan.</span>
      </div>
      <List>{checks.map((c) => <CheckRow key={c.id} c={c} serverId={serverId} />)}</List>
    </details>
  );
}

type PanelState = { kind: 'discover'; found: DiscoverResult } | { kind: 'add' } | { kind: 'services' } | null;

export function ChecksPanel({ serverId, checks }: { serverId: number; checks: Check[] }) {
  const meta = useQuery(q.checksMeta()).data;
  const [panel, setPanel] = useState<PanelState>(null);
  const close = () => setPanel(null);
  const discover = async () => { toast('Membaca layanan yang berjalan...'); setPanel({ kind: 'discover', found: await post<DiscoverResult>(`/api/servers/${serverId}/discover`) }); };
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="grow" />
        <Button icon={IconList} onClick={() => setPanel({ kind: 'services' })}>Pilih layanan</Button>
        <Button icon={IconEye} onClick={discover}>Deteksi paket</Button>
        <Button icon={IconPlus} onClick={() => setPanel({ kind: 'add' })}>Tambah pemeriksaan</Button>
      </div>
      <p className="lbl" style={{ marginBottom: 10 }}>Satu perintah baca-saja lewat SSH per pemeriksaan. Peringatan baru muncul setelah gagal berturut-turut. Kelompok yang bermasalah terbuka otomatis.</p>
      <Modal open={panel !== null} onClose={close}>
        {meta && panel?.kind === 'discover' && <DiscoverPanel serverId={serverId} meta={meta} found={panel.found} onClose={close} />}
        {meta && panel?.kind === 'add' && <AddCheckPanel serverId={serverId} meta={meta} onClose={close} />}
        {panel?.kind === 'services' && <ServicesPanel serverId={serverId} existing={checks.map((c) => c.name)} onClose={close} />}
      </Modal>
      {checks.length
        ? (() => { const groups = groupChecks(checks, meta?.packs); return groups.map((g) => <CheckGroup key={g.key} label={g.label} checks={g.checks} worst={g.worst} serverId={serverId} open={groups.length === 1 || ['crit', 'warn', 'unknown'].includes(g.worst)} />); })()
        : <Empty>Belum ada pemeriksaan layanan. Tekan "Deteksi layanan" untuk menyarankan paket dari apa yang berjalan di server ini.</Empty>}
    </div>
  );
}

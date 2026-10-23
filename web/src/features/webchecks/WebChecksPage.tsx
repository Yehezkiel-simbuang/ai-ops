// Layanan tanpa SSH: aplikasi membuka URL secara berkala (hidup/mati, kecepatan, sertifikat HTTPS) atau menanyakan API penyedia (Vercel).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAction } from '@/api/queries';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { Async } from '@/components/ui/Async';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Empty, Item, List, Note, PageHead, Section } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconClose, IconGlobe, IconPause, IconPlay, IconPlus, IconRefresh, IconTrash } from '@/components/icons';
import { del, patch, post } from '@/lib/api';
import { ago } from '@/lib/format';
import { webQ } from './queries';
import type { NewWebCheck, VercelForm, WebCheck, WebKind, WebStatus } from './types';

export const STATUS: Record<WebStatus, [Tone, string]> = { belum: ['mute', 'Belum diperiksa'], sehat: ['ok', 'Sehat'], minor: ['acc', 'Minor'], major: ['warn', 'Major'], critical: ['bad', 'Critical'] };
const KINDS: Record<WebKind, string> = { http: 'Situs atau API (buka alamatnya)', vercel: 'Vercel (deploy produksi terakhir)' };
const MIN_INTERVAL: Record<WebKind, number> = { http: 30, vercel: 300 };
const URL_OK = /^https?:\/\/\S+$/;

/** Sisa hari sertifikat; null bila tidak diketahui (http biasa). */
export const certDays = (c: Pick<WebCheck, 'cert_expires'>, now = Date.now()): number | null => (c.cert_expires ? Math.floor((c.cert_expires - now) / 864e5) : null);

function Row({ c }: { c: WebCheck }) {
  const { confirm } = useDialogs(), invalidate = [['webchecks']], vercel = c.kind === 'vercel';
  const run = useAction(() => post(`/api/webchecks/${c.id}/run`), { invalidate });
  const toggle = useAction(() => patch(`/api/webchecks/${c.id}`, { enabled: !c.enabled }), { invalidate });
  const remove = useAction(() => del(`/api/webchecks/${c.id}`), { invalidate });
  const [tone, label] = c.enabled ? STATUS[c.last_status] : (['mute', 'Dijeda'] as [Tone, string]), days = certDays(c);
  return (
    <Item title={c.name} off={!c.enabled} sub={[
      vercel ? `Vercel: ${c.url.replace(/^vercel:/, '')}` : c.url,
      c.last_run ? `${c.last_title}${c.last_detail && c.last_status !== 'sehat' ? ` (${c.last_detail})` : ''} | diperiksa ${ago(c.last_run)}` : 'Menunggu pemeriksaan pertama',
      c.uptime24h !== null ? `${vercel ? 'pemeriksaan sehat 24 jam' : 'uptime 24 jam'} ${c.uptime24h}%${vercel ? '' : ` | rata-rata ${c.avgMs24h ?? '-'} ms`} | ${c.samples24h} pemeriksaan` : '',
      days !== null ? `sertifikat ${days < 0 ? 'kedaluwarsa' : `${days} hari lagi`}` : ''
    ].filter(Boolean)}>
      <Badge tone={tone}>{label}</Badge>
      <Button icon={IconRefresh} aria-label={`Periksa ${c.name} sekarang`} onClick={() => run.mutateAsync()}>Periksa</Button>
      <Button icon={c.enabled ? IconPause : IconPlay} aria-label={`${c.enabled ? 'Jeda' : 'Lanjutkan'} ${c.name}`} onClick={() => toggle.mutateAsync()} />
      <Button icon={IconTrash} aria-label={`Hapus ${c.name}`} onClick={async () => { if (await confirm(`Hapus pemantauan "${c.name}" beserta riwayatnya?`, 'Hapus')) await remove.mutateAsync(); }} />
    </Item>
  );
}

const INITIAL: NewWebCheck = { name: '', url: '', interval_s: 60, slow_ms: 2000, confirm: 2 };
const INITIAL_VERCEL: VercelForm = { token: '', project: '', teamId: '' };

function NewForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState<NewWebCheck>(INITIAL), [kind, setKind] = useState<WebKind>('http'), [v, setV] = useState<VercelForm>(INITIAL_VERCEL);
  const payload = () => (kind === 'vercel'
    ? { kind, name: f.name.trim(), interval_s: Math.max(f.interval_s, MIN_INTERVAL.vercel), confirm: f.confirm, vercel: { token: v.token.trim(), project: v.project.trim(), ...(v.teamId.trim() ? { teamId: v.teamId.trim() } : {}) } }
    : { kind, ...f, name: f.name.trim(), url: f.url.trim() });
  const add = useAction(() => post('/api/webchecks', payload()), { success: 'Ditambahkan. Pemeriksaan pertama berjalan sebentar lagi.', invalidate: [['webchecks']], onSuccess: () => { setF(INITIAL); setV(INITIAL_VERCEL); onDone(); } });
  const num = (k: keyof NewWebCheck) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });
  const ready = f.name.trim() !== '' && (kind === 'vercel' ? v.token.trim().length >= 10 && v.project.trim() !== '' : URL_OK.test(f.url.trim()));
  const pickKind = (k: WebKind) => { setKind(k); setF({ ...f, interval_s: k === 'vercel' ? MIN_INTERVAL.vercel : INITIAL.interval_s }); };
  return (
    <div className="form">
      <h3>Tambah layanan</h3>
      <Field label="Nama"><input placeholder="Toko online" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Jenis"><select aria-label="Jenis pemantauan" value={kind} onChange={(e) => pickKind(e.target.value as WebKind)}>{Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      {kind === 'http' ? (
        <Field label="Alamat (URL)"><input className="mono" placeholder="https://tokoku.com" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
      ) : (
        <>
          <Field label="Nama atau ID proyek Vercel"><input className="mono" placeholder="tokoku" value={v.project} onChange={(e) => setV({ ...v, project: e.target.value })} /></Field>
          <Field label="Token akses Vercel"><input type="password" autoComplete="off" value={v.token} onChange={(e) => setV({ ...v, token: e.target.value })} /></Field>
          <Field label="ID tim (kosongkan bila akun pribadi)"><input className="mono" placeholder="team_..." value={v.teamId} onChange={(e) => setV({ ...v, teamId: e.target.value })} /></Field>
          <p className="lbl">Token dibuat di Vercel (Account Settings, Tokens). Disimpan terenkripsi dan tidak pernah ditampilkan lagi. Buat token khusus untuk ini dan batasi ke tim yang perlu. Server hanya membaca daftar deploy.</p>
        </>
      )}
      <div className="row">
        <Field label="Periksa tiap (detik)"><input type="number" min={MIN_INTERVAL[kind]} max={3600} value={f.interval_s} onChange={num('interval_s')} /></Field>
        {kind === 'http' && <Field label="Dianggap lambat bila (ms)"><input type="number" min={100} value={f.slow_ms} onChange={num('slow_ms')} /></Field>}
        <Field label="Beri tahu setelah (kali gagal)"><input type="number" min={1} max={10} value={f.confirm} onChange={num('confirm')} /></Field>
      </div>
      <p className="lbl">Gagal sekali belum tentu masalah; notifikasi baru dikirim setelah gagal berturut-turut sebanyak angka di atas, dan sekali lagi saat pulih.</p>
      <div className="row"><Button primary icon={IconPlus} disabled={!ready} onClick={() => add.mutateAsync()}>Tambah</Button><Button icon={IconClose} onClick={onDone}>Batal</Button></div>
    </div>
  );
}

export function WebChecksPage() {
  const query = useQuery(webQ.list()), [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead title="Layanan" icon={IconGlobe}><Button primary icon={IconPlus} onClick={() => setAdding(true)}>Tambah layanan</Button></PageHead>
      <Note>Untuk situs atau API yang tidak bisa (atau tidak perlu) diakses lewat SSH, misalnya di Vercel atau Supabase. Jenis "buka alamatnya" hanya terlihat seperti pengunjung: tahu bila bermasalah, belum tahu sebabnya. Jenis Vercel menanyakan status deploy lewat API-nya.</Note>
      <Async query={query}>{(list) => (
        <>
          <Section title={`Dipantau (${list.length})`} icon={IconGlobe}>
            {list.length === 0 ? <Empty>Belum ada layanan. Tekan "Tambah layanan" di kanan atas dan isi alamat situs Anda.</Empty> : <List>{list.map((c) => <Row key={c.id} c={c} />)}</List>}
          </Section>
        </>
      )}</Async>
      <Modal open={adding} onClose={() => setAdding(false)}><NewForm onDone={() => setAdding(false)} /></Modal>
    </>
  );
}

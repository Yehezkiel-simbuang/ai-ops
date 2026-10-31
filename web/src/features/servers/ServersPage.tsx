import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { q, useAction } from '@/api/queries';
import type { ConnectionTest, ExecVia, Server, ServerInput } from '@/api/types';
import { useDialogs } from '@/components/dialogs/DialogProvider';
import { ServerStatusBadge } from '@/components/StatusBadges';
import { Async } from '@/components/ui/Async';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import { Field, useForm } from '@/components/ui/Field';
import { AgentFleet } from '@/features/agent/AgentFleet';
import { DataGrid, type Column } from '@/components/ui/DataGrid';
import { Empty, Hint, PageHead } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { IconBolt, IconBook, IconCheck, IconClose, IconCpu, IconFolder, IconKey, IconPlus, IconPulse, IconRefresh, IconServer, IconTrash, IconWrench } from '@/components/icons';
import { del, post, put } from '@/lib/api';
import { ago } from '@/lib/format';
import { toast } from '@/lib/toast';
import { installCommand, installHelp } from './pubkey';

const EMPTY = {
  name: '', host: '', port: 22, username: '', key_path: '', ssh_key: '', services: '', notes: '', use_sudo: false, playground: false, exec_via: 'auto' as ExecVia
};
const EXEC_OPTIONS: Array<[ExecVia, string]> = [['auto', 'Otomatis (SSH bila ada kunci, jika tidak lewat agen)'], ['ssh', 'Selalu SSH'], ['agent', 'Selalu lewat agen di server']];

const fromServer = (s: Server) => ({ ...EMPTY, name: s.name, host: s.host, port: s.port, username: s.username, key_path: s.key_path, services: s.services, notes: s.notes, use_sudo: s.use_sudo, playground: s.playground, exec_via: s.exec_via });

function ServerForm({ editing, onDone }: { editing: Server | null; onDone: () => void }) {
  const { values, bind, bindCheck, reset, set } = useForm(editing ? fromServer(editing) : EMPTY);
  const { showText, confirm } = useDialogs(), fileRef = useRef<HTMLInputElement>(null), [generate, setGenerate] = useState(false);
  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const text = (await file.text()).replace(/\r\n/g, '\n').trim();
    if (file.size > 16_000 || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) { toast('Berkas itu bukan kunci privat SSH. Pilih berkas aiops_key (yang tanpa .pub).', true); return; }
    set('ssh_key', text); setGenerate(false); toast('Kunci terbaca dari berkas. Tekan Simpan untuk menyimpannya.');
  };
  const save = useAction(
    async () => {
      const body = { ...values, port: Number(values.port), ssh_key: generate ? undefined : String(values.ssh_key).trim() || undefined, ...(generate ? { generate_key: true } : {}) } as unknown as ServerInput;
      return editing ? put(`/api/servers/${editing.id}`, body) : post('/api/servers', body);
    },
    {
      success: 'Server disimpan', invalidate: [['servers'], ['overview'], ['inventory']],
      onSuccess: (saved) => { reset(EMPTY); setGenerate(false); onDone(); const pub = (saved as { ssh_pub?: string } | undefined)?.ssh_pub; if (pub) showText('Pasang kunci publik di server', installHelp(String(values.username)), installCommand(pub, String(values.username))); }
    }
  );
  const readyToSave = String(values.name).trim() !== '' && String(values.host).trim() !== '' && String(values.username).trim() !== '';
  const hasKey = generate || String(values.ssh_key).trim() !== '' || String(values.key_path).trim() !== '' || !!editing?.has_ssh_key;   // SSH key wajib; login dengan password tidak didukung
  const keyPlaceholder = editing?.has_ssh_key ? '(kunci tersimpan terenkripsi; tempel kunci baru untuk menggantinya)' : '-----BEGIN OPENSSH PRIVATE KEY-----';
  return (
    <form className="form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h2><IconPlus size={16} aria-hidden />{editing ? `Ubah ${editing.name}` : 'Tambah server'}</h2>
      <div className="cols tight">
        <Field label="Nama"><input required maxLength={60} placeholder="srv-database" {...bind('name')} /></Field>
        <Field label="Host / IP"><input required className="mono" placeholder="10.0.0.5" {...bind('host')} /></Field>
      </div>
      <div className="cols tight">
        <Field label="Pengguna SSH"><input required className="mono" placeholder="ops" {...bind('username')} /></Field>
        <Field label="Port"><input type="number" min={1} max={65535} {...bind('port')} /></Field>
      </div>
      <Hint icon={IconBook}><span>Belum punya kunci SSH atau belum tahu apa yang dilakukan di server? Ikuti <Link to="/panduan?bagian=kunci">panduan langkah demi langkah</Link> (Windows, macOS, Linux).</span></Hint>
      <Field label="Kunci privat SSH (wajib, disimpan terenkripsi)" hint="Tempel isi berkas kunci tanpa passphrase. Tidak pernah ditampilkan kembali. Kosongkan bila memakai berkas di bawah. Login dengan password tidak didukung.">
        <textarea className="mono" style={{ minHeight: 90, fontSize: '.78rem' }} spellCheck={false} autoComplete="off" disabled={generate} placeholder={generate ? 'Kunci akan dibuat otomatis saat Simpan. Kunci publiknya lalu ditampilkan untuk dipasang di server.' : keyPlaceholder} {...bind('ssh_key')} />
      </Field>
      <div className="row">
        <input ref={fileRef} type="file" hidden aria-label="Berkas kunci privat" onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ''; }} />
        <Button icon={IconFolder} onClick={() => fileRef.current?.click()}>Pilih berkas kunci</Button>
        <Button icon={IconKey} aria-pressed={generate} onClick={async () => { if (!generate && editing?.has_ssh_key && !(await confirm('Server ini sudah punya kunci. Membuat kunci baru menggantinya, dan server tidak bisa dijangkau sampai kunci publik yang baru dipasang di server. Lanjutkan?', 'Ganti kunci'))) return; setGenerate(!generate); if (!generate) set('ssh_key', ''); }}>{generate ? 'Batal buat otomatis' : 'Buat kunci otomatis'}</Button>
      </div>
      {generate && (
        <Hint icon={IconKey}>
          <div>
            <b>Kunci belum dibuat.</b> Isi nama, host, dan pengguna SSH di atas, lalu tekan tombol di bawah. Kunci publik akan muncul di jendela baru untuk Anda salin dan pasang di server.
            <div className="row" style={{ marginTop: 8 }}><Button primary icon={IconCheck} disabled={save.isPending || !readyToSave} onClick={() => save.mutateAsync()}>Simpan dan buat kunci</Button></div>
            {!readyToSave && <div className="lbl" style={{ marginTop: 6 }}>Tombol aktif setelah nama, host, dan pengguna SSH terisi.</div>}
          </div>
        </Hint>
      )}
      <p className="lbl">Dua cara mudah: pilih berkas <code>aiops_key</code> dari komputer Anda (dibaca di browser lalu disimpan terenkripsi), atau minta aplikasi membuatkan pasangan kunci sehingga Anda hanya perlu memasang kunci publiknya di server.</p>
      <details>
        <summary className="lbl" style={{ cursor: 'pointer' }}>Opsi lanjutan: pakai berkas kunci di dalam kontainer (jarang dipakai)</summary>
        <Field label="Path berkas kunci di dalam kontainer aplikasi" hint="Hanya bila kunci Anda sengaja dipasang sebagai berkas di kontainer (mis. docker secret). Path ini ada di dalam kontainer, bukan di komputer Anda, dan berkasnya harus ada di sana. Kunci yang sudah tersimpan di atas didahulukan.">
          <input className="mono" placeholder="/run/secrets/ssh_key (alternatif dari menempel kunci)" {...bind('key_path')} />
        </Field>
      </details>
      <Field label="Layanan yang dipantau (pisah koma)"><input className="mono" placeholder="mysql,nginx,php8.2-fpm" {...bind('services')} /></Field>
      <label className="checkline"><input type="checkbox" {...bindCheck('use_sudo')} /><span>Pengguna ini punya sudo tanpa password (agen boleh memakai "sudo -n")</span></label>
      <label className="checkline"><input type="checkbox" {...bindCheck('playground')} /><span><b>Server playground</b>: khusus uji. Susunan Docker Compose boleh dipasang dan dicopot di sini (halaman Playground). Jangan centang untuk server produksi.</span></label>
      <Field label="Jalur eksekusi perbaikan" hint="Perbaikan yang Anda setujui dijalankan lewat jalur ini.">
        <select {...bind('exec_via')}>{EXEC_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
      </Field>
      <Field label="Catatan untuk agen" hint="Mis. peran server, hal yang tidak boleh disentuh, jam sibuk."><textarea {...bind('notes')} /></Field>
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending || !hasKey} title={hasKey ? undefined : 'Isi kunci privat SSH atau path berkas kunci'}><IconCheck size={16} aria-hidden />{generate ? 'Simpan dan buat kunci' : 'Simpan'}</button>
        <Button icon={IconClose} onClick={() => { reset(EMPTY); onDone(); }}>Batal</Button>
      </div>
    </form>
  );
}

/** Tombol aksi satu server. Yang sering dipakai (Monitor, Uji koneksi) tampil dengan teks; sisanya ikon dengan keterangan. */
function ServerActions({ s, onEdit }: { s: Server; onEdit: (s: Server) => void }) {
  const { confirm, showText } = useDialogs(), navigate = useNavigate();
  const refresh = [['servers'], ['overview']];
  const test = useAction(() => post<ConnectionTest>(`/api/servers/${s.id}/test`), {
    invalidate: refresh,
    onSuccess: async (r) => {
      if (r.ok) { toast(`Terhubung: ${r.info}`); return; }
      if (!r.hint) { toast(`Gagal: ${r.error}`, true); return; }
      // galat yang dikenali: jelaskan penyebab dan langkah berikutnya, tawarkan panduan
      const open = await confirm(<div><p><b>Koneksi ke {s.name} gagal.</b></p><p className="mono" style={{ wordBreak: 'break-word' }}>{r.error}</p><p>{r.hint}</p></div>, 'Buka panduan');
      if (open) navigate('/panduan?bagian=server');
    }
  });
  const check = useAction(() => post<{ ok: boolean; created: unknown[] }>(`/api/servers/${s.id}/check`), {
    invalidate: refresh, onSuccess: (r) => toast(r.ok ? `Pemeriksaan selesai${r.created.length ? `, ${r.created.length} peringatan baru` : ''}` : 'Server tidak terjangkau', !r.ok)
  });
  const remove = useAction(() => del(`/api/servers/${s.id}`), { invalidate: [...refresh, ['inventory']] });
  return (
    <div className="row" style={{ gap: 6 }}>
      <LinkButton to={`/monitor/${s.id}`} icon={IconPulse}>Monitor</LinkButton>
      <LinkButton to={`/agen/${s.id}`} icon={IconCpu}>Agen</LinkButton>
      <Button icon={IconBolt} onClick={() => test.mutateAsync()}>Uji koneksi</Button>
      <Button icon={IconRefresh} title="Periksa sekarang" onClick={() => check.mutateAsync()}>Periksa</Button>
      <Menu label={`Aksi lain ${s.name}`} items={[
        { label: 'Kunci publik', icon: IconKey, hidden: !s.ssh_pub, onSelect: () => showText(`Pasang kunci publik: ${s.name}`, installHelp(s.username), installCommand(s.ssh_pub!, s.username)) },
        { label: 'Ubah', icon: IconWrench, onSelect: () => onEdit(s) },
        { label: 'Hapus', icon: IconTrash, danger: true, onSelect: async () => { if (await confirm(`Hapus server ${s.name} beserta metrik dan peringatannya?`, 'Hapus')) await remove.mutateAsync(); } }
      ]} />
    </div>
  );
}

const STATUS_RANK: Record<string, number> = { 'tidak terjangkau': 0, peringatan: 1, belum: 2, ok: 3 };

export function ServersPage() {
  const query = useQuery(q.servers()), [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<'baru' | Server | null>(null);   // null = tertutup, 'baru' = server baru, Server = ubah
  const close = () => setDialog(null), needle = search.trim().toLowerCase();
  const columns = (onEdit: (s: Server) => void): Array<Column<Server>> => [
    { id: 'name', header: 'Server', sort: (s) => s.name, cell: (s) => <><b>{s.name}</b> {s.playground && <Badge tone="acc">playground</Badge>}<div className="lbl mono">{s.username}@{s.host}:{s.port}</div></> },
    { id: 'status', header: 'Status', sort: (s) => STATUS_RANK[s.last_status] ?? 2, cell: (s) => <><ServerStatusBadge status={s.last_status} /><div className="lbl">{s.last_seen ? `terakhir terlihat ${ago(s.last_seen)}` : 'belum pernah terlihat'}</div></> },
    { id: 'os', header: 'Sistem', sort: (s) => s.os_info, cell: (s) => <span className="lbl">{s.os_info || '-'}</span> },
    { id: 'key', header: 'Akses', sort: (s) => (s.has_ssh_key ? 'kunci tersimpan' : s.key_path || 'tanpa kunci'), cell: (s) => <span className="lbl">{s.has_ssh_key ? 'kunci tersimpan' : s.key_path ? `kunci: ${s.key_path}` : 'tanpa kunci (ssh bawaan)'}</span> },
    { id: 'act', header: 'Aksi', cell: (s) => <ServerActions s={s} onEdit={onEdit} /> }
  ];
  return (
    <>
      <PageHead title="Server" icon={IconServer}><Button primary icon={IconPlus} onClick={() => setDialog('baru')}>Tambah server</Button></PageHead>
      <Async query={query}>{(servers) => servers.length ? (
        <>
          <AgentFleet />
          {servers.length > 5 && <div className="row" style={{ marginBottom: 8 }}><input type="search" aria-label="Cari server" placeholder="Cari nama atau alamat..." style={{ maxWidth: 360, width: '100%' }} value={search} onChange={(e) => setSearch(e.target.value)} /></div>}
          <DataGrid label="Daftar server" rows={servers.filter((s) => !needle || `${s.name} ${s.host} ${s.username}`.toLowerCase().includes(needle))} columns={columns(setDialog)} rowKey={(s) => s.id}
            storageKey="aiops.server.size" defaultSort={{ id: 'status', dir: 'asc' }} resetKey={needle} empty="Tidak ada server yang cocok dengan pencarian." />
        </>
      ) : <Empty>Belum ada server. Tekan "Tambah server" di kanan atas. Belum punya kunci SSH? Buka <Link to="/panduan?bagian=kunci">panduan menambah server</Link>.</Empty>}
      </Async>
      <Modal open={dialog !== null} onClose={close}>
        <ServerForm key={dialog === 'baru' || dialog === null ? 'baru' : dialog.id} editing={dialog === 'baru' || dialog === null ? null : dialog} onDone={close} />
      </Modal>
      <p className="lbl" style={{ marginTop: 14 }}>Dokumentasi lengkap tiap server (fungsi, alamat, kredensial, pemeliharaan) ada di <Link to="/inventaris">Inventaris</Link>.</p>
    </>
  );
}

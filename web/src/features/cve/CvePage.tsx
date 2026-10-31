// Cek CVE: ketik nomor CVE, lihat apakah server Anda terdampak, apakah patch sudah ada, dan apa yang bisa dilakukan sekarang.
// Yang resmi (teks mitigasi dari Ubuntu) dan yang umum (langkah wajar, bukan penawar khusus CVE itu) diberi label berbeda.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAction } from '@/api/queries';
import { Async } from '@/components/ui/Async';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Empty, Hint, Item, List, Note, PageHead, Section } from '@/components/ui/Layout';
import { IconAlert, IconCheck, IconEye, IconList, IconServer, IconShield, IconTrash } from '@/components/icons';
import { del, post } from '@/lib/api';
import { ago } from '@/lib/format';
import { toast } from '@/lib/toast';
import { CVE_RE, cveQ } from './queries';
import type { Advice, CveLookup, ServerVerdict, Verdict } from './types';

export const VERDICT: Record<Verdict, [Tone, string]> = {
  rentan_tanpa_patch: ['bad', 'Rentan, belum ada patch'], rentan_patch_tersedia: ['warn', 'Rentan, patch tersedia'], tidak_diketahui: ['mute', 'Belum bisa dinilai'], aman: ['ok', 'Sudah aman'], tidak_terdampak: ['ok', 'Tidak terdampak']
};
const statusTone = (s: string): Tone => (s === 'released' ? 'ok' : s === 'pending' ? 'warn' : s === 'not-affected' || s === 'DNE' ? 'mute' : 'bad');
const statusText = (s: string, fixed: string): string => (s === 'released' ? `dirilis ${fixed}` : s === 'pending' ? `disiapkan ${fixed}` : s === 'not-affected' ? 'tidak terdampak' : s === 'DNE' ? 'tidak ada' : s === 'needed' ? 'belum ada' : s);

function ServerRow({ s }: { s: ServerVerdict }) {
  const [tone, text] = VERDICT[s.verdict];
  const sub = [`${s.host}${s.os ? ` | ${s.os}` : ''}${s.kernel ? ` | kernel ${s.kernel}` : ''}`, ...s.packages.filter((p) => p.verdict !== 'tidak_terdampak').slice(0, 3).map((p) => `${p.name}: ${p.text}`), ...(s.note ? [s.note] : [])];
  return <Item to={`/inventaris/${s.server_id}`} title={s.name} sub={sub}><Badge tone={tone}>{text}</Badge></Item>;
}

function AdviceRow({ a }: { a: Advice }) {
  return (
    <li className="finding">
      <div className="row"><Badge tone={a.kind === 'resmi' ? 'info' : 'mute'}>{a.kind}</Badge> <b>{a.title}</b></div>
      <div className="lbl">{a.text}</div>
      {a.link && <Badge tone="acc" to={a.link}>Buka halaman patch</Badge>}
    </li>
  );
}

function Result({ d }: { d: CveLookup }) {
  const watch = useAction(() => (d.watching ? del(`/api/cve/${d.id}/watch`) : post(`/api/cve/${d.id}/watch`)), {
    success: d.watching ? 'Tidak lagi dipantau' : 'Dipantau: Anda akan dikabari saat status perbaikannya berubah', invalidate: [['cve']]
  });
  if (!d.found) return <Empty>{d.id} tidak ditemukan di tracker Ubuntu maupun OSV.dev (Ubuntu: {d.sources.ubuntu}; OSV: {d.sources.osv}). Periksa nomornya, atau CVE-nya mungkin belum dipublikasikan.</Empty>;
  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>{d.id}</h2>
          {d.priority && <Badge tone={d.priority === 'critical' || d.priority === 'high' ? 'bad' : 'warn'}>prioritas {d.priority}</Badge>}
          {d.cvss != null && <Badge tone={d.cvss >= 9 ? 'bad' : d.cvss >= 7 ? 'warn' : 'mute'}>CVSS {d.cvss.toFixed(1)}</Badge>}
          {d.kev === true ? <Badge tone="bad" icon={IconAlert}>sedang dieksploitasi (CISA KEV)</Badge> : <Badge tone="mute">{d.kev === false ? 'tidak ada di daftar KEV' : 'daftar KEV belum dimuat'}</Badge>}
          <Button icon={d.watching ? IconTrash : IconEye} onClick={() => watch.mutateAsync()} disabled={watch.isPending}>{d.watching ? 'Berhenti memantau' : 'Pantau perkembangan perbaikan'}</Button>
        </div>
        <p>{d.summary}</p>
        <div className="lbl">
          {d.published ? `Terbit ${d.published.slice(0, 10)}` : ''}{d.updated ? ` | diperbarui ${d.updated.slice(0, 10)}` : ''} | sumber: Ubuntu {d.sources.ubuntu}, OSV {d.sources.osv}
          {d.references.slice(0, 3).map((u) => <span key={u}> | <a href={u} target="_blank" rel="noreferrer">{u.replace(/^https?:\/\//, '').slice(0, 48)}</a></span>)}
        </div>
      </div>

      <Section title="Server Anda" icon={IconServer}>
        {d.servers.length ? <List>{d.servers.map((s) => <ServerRow key={s.server_id} s={s} />)}</List> : <Empty>Belum ada server terdaftar.</Empty>}
      </Section>

      {d.advice.length > 0 && (
        <Section title="Yang bisa dilakukan" icon={IconCheck}>
          <ul className="plain stack">{d.advice.map((a, i) => <AdviceRow key={`${a.title}-${i}`} a={a} />)}</ul>
          <Note>Label <b>resmi</b> = teks yang diterbitkan Ubuntu. Label <b>umum</b> = langkah wajar untuk jenis masalah ini yang mengurangi risiko; bukan penawar khusus CVE ini dan tidak menjamin menutup kerentanannya.</Note>
        </Section>
      )}

      {d.matrix.length > 0 && (
        <Section title="Status perbaikan per rilis Ubuntu" icon={IconList}>
          <div className="tbl-wrap"><table className="tbl" aria-label="Status per rilis">
            <thead><tr><th>Paket</th>{d.matrixReleases.map((r) => <th key={r}>{d.releaseLabels[r] ?? r}</th>)}</tr></thead>
            <tbody>{d.matrix.map((p) => (
              <tr key={p.name}><td><code>{p.name}</code></td>{d.matrixReleases.map((r) => { const st = p.statuses[r]; return <td key={r}>{st ? <Badge tone={statusTone(st.status)}>{statusText(st.status, st.fixed)}</Badge> : '-'}</td>; })}</tr>
            ))}</tbody>
          </table></div>
          {d.matrixTotal > d.matrix.length && <p className="lbl">Menampilkan {d.matrix.length} dari {d.matrixTotal} paket; yang relevan bagi server Anda diurutkan lebih dulu.</p>}
        </Section>
      )}
      {d.description && <details><summary>Deskripsi lengkap</summary><pre className="out">{d.description}</pre></details>}
    </div>
  );
}

export function CvePage() {
  const { id = '' } = useParams(), navigate = useNavigate(), [text, setText] = useState(id);
  useEffect(() => { setText(id); }, [id]);
  const valid = CVE_RE.test(id), result = useQuery({ ...cveQ.lookup(id), enabled: valid }), watches = useQuery(cveQ.watches());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim().toUpperCase(); if (!CVE_RE.test(t)) { toast('Format CVE tidak valid. Contoh: CVE-2026-98432', true); return; }
    navigate(`/cve/${t}`);
  };
  return (
    <>
      <PageHead title="Cek CVE" icon={IconShield} />
      <Note>Ketik nomor CVE untuk melihat apakah server Ubuntu Anda terdampak, apakah perbaikannya sudah dirilis, dan apa yang bisa dilakukan sekarang. Sumber: tracker keamanan Ubuntu dan OSV.dev. Aplikasi membaca daftar paket terpasang lewat SSH (hanya membaca). Server tanpa data OS atau bukan Ubuntu ditandai "belum bisa dinilai", bukan aman.</Note>
      <form className="row" onSubmit={submit} style={{ margin: '12px 0' }}>
        <input id="cve-id" aria-label="Nomor CVE" placeholder="CVE-2026-98432" value={text} onChange={(e) => setText(e.target.value)} style={{ maxWidth: 260 }} />
        <Button primary type="submit" icon={IconShield} disabled={result.isFetching}>Cek</Button>
      </form>
      {id && !valid && <Hint icon={IconAlert}>"{id}" bukan nomor CVE yang valid. Contoh: CVE-2026-98432.</Hint>}
      {valid && <Async query={result}>{(d) => <Result d={d} />}</Async>}
      <Section title="CVE yang dipantau" icon={IconEye}>
        <Async query={watches}>{(rows) => rows.length ? (
          <List>{rows.map((w) => <Item key={w.cve} to={`/cve/${w.cve}`} title={w.cve} sub={[`${w.state.map((s) => `${s.key}: ${s.value}`).join(', ') || 'belum ada data'} | dicek ${ago(w.last_check)}${w.notified ? ` | terakhir mengabari ${ago(w.notified)}` : ''}`]} />)}</List>
        ) : <Empty>Belum ada. Buka sebuah CVE lalu tekan "Pantau perkembangan perbaikan"; aplikasi mengecek tracker Ubuntu tiap 6 jam dan mengabari saat perbaikannya dirilis.</Empty>}</Async>
      </Section>
    </>
  );
}

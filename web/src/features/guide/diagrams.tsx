// Diagram untuk panduan. SVG murni (tanpa pustaka), warna dari token tema sehingga terbaca di mode terang dan gelap.
import { useId, type ReactNode } from 'react';

type Tone = 'plain' | 'secret' | 'public' | 'accent';
const STROKE: Record<Tone, string> = { plain: 'var(--line-strong)', secret: 'var(--warn)', public: 'var(--ok)', accent: 'var(--accent)' };

interface BoxProps { x: number; y: number; w: number; h: number; title: string; lines?: string[]; tone?: Tone }
function Box({ x, y, w, h, title, lines = [], tone = 'plain' }: BoxProps) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill="var(--panel-2)" stroke={STROKE[tone]} strokeWidth={tone === 'plain' ? 1.5 : 2.5} />
      <text x={x + w / 2} y={y + 26} textAnchor="middle" fontSize={15} fontWeight={600} fill="var(--ink)">{title}</text>
      {lines.map((l, i) => <text key={l} x={x + w / 2} y={y + 48 + i * 18} textAnchor="middle" fontSize={12.5} fill="var(--muted)">{l}</text>)}
    </g>
  );
}

interface ArrowProps { from: [number, number]; to: [number, number]; marker: string; dashed?: boolean }
function Arrow({ from, to, marker, dashed }: ArrowProps) {
  return <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke="var(--accent)" strokeWidth={2.2} strokeDasharray={dashed ? '6 5' : undefined} markerEnd={`url(#${marker})`} />;
}

function Label({ x, y, children, anchor = 'middle' }: { x: number; y: number; children: ReactNode; anchor?: 'start' | 'middle' | 'end' }) {
  return <text x={x} y={y} textAnchor={anchor} fontSize={13} fontWeight={600} fill="var(--ink)" stroke="var(--bg)" strokeWidth={5} paintOrder="stroke">{children}</text>;
}

function Frame({ label, viewBox, children }: { label: string; viewBox: string; children: (marker: string) => ReactNode }) {
  const marker = `ah-${useId().replace(/:/g, '')}`;
  return (
    <figure className="diagram">
      <svg viewBox={viewBox} role="img" aria-label={label} style={{ width: '100%', height: 'auto', maxWidth: 720 }}>
        <defs><marker id={marker} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--accent)" /></marker></defs>
        {children(marker)}
      </svg>
    </figure>
  );
}

/** Peta besar: tiga pihak dan apa yang dipegang masing-masing. */
export function KeyMap() {
  return (
    <Frame label="Peta: komputer Anda membuat kunci, kunci privat ditempel ke AI Ops, kunci publik dipasang di server yang dipantau, lalu AI Ops masuk ke server lewat SSH" viewBox="0 0 680 340">
      {(m) => (
        <>
          <Box x={240} y={8} w={200} h={84} title="Komputer Anda" lines={['Membuat pasangan kunci', 'Membuka AI Ops di browser']} />
          <Box x={20} y={230} w={240} h={94} title="AI Ops (aplikasi)" lines={['Berjalan di Docker', 'Menyimpan kunci PRIVAT']} tone="secret" />
          <Box x={420} y={230} w={240} h={94} title="Server yang dipantau" lines={['Linux yang bisa di-SSH', 'Menyimpan kunci PUBLIK']} tone="public" />
          <Arrow from={[285, 92]} to={[165, 228]} marker={m} />
          <Arrow from={[395, 92]} to={[515, 228]} marker={m} />
          <Arrow from={[262, 277]} to={[418, 277]} marker={m} />
          <Label x={212} y={150} anchor="end">1. tempel kunci privat</Label>
          <Label x={468} y={150} anchor="start">2. pasang kunci publik</Label>
          <Label x={340} y={262}>3. login SSH</Label>
          <Label x={340} y={300}>dengan kunci</Label>
        </>
      )}
    </Frame>
  );
}

/** Pasangan kunci: ke mana masing-masing berkas pergi. */
export function KeyPair() {
  return (
    <Frame label="Dua berkas kunci: aiops_key yang privat ditempel ke menu Server di AI Ops; aiops_key.pub yang publik dipasang di authorized_keys server" viewBox="0 0 680 210">
      {(m) => (
        <>
          <Box x={10} y={14} w={230} h={74} title="aiops_key (PRIVAT)" lines={['Rahasia. Jangan dibagikan.']} tone="secret" />
          <Box x={440} y={14} w={230} h={74} title="AI Ops: menu Server" lines={['Ditempel di kolom kunci privat']} />
          <Arrow from={[242, 51]} to={[438, 51]} marker={m} />
          <Label x={340} y={42}>tempel isinya</Label>
          <Box x={10} y={118} w={230} h={74} title="aiops_key.pub (PUBLIK)" lines={['Aman dibagikan.']} tone="public" />
          <Box x={440} y={118} w={230} h={74} title="Server yang dipantau" lines={['Berkas ~/.ssh/authorized_keys']} />
          <Arrow from={[242, 155]} to={[438, 155]} marker={m} />
          <Label x={340} y={146}>pasang di server</Label>
        </>
      )}
    </Frame>
  );
}

/** Dua jalur komunikasi: SSH dari AI Ops, dan laporan HTTPS dari agen. */
export function AgentFlow() {
  return (
    <Frame label="AI Ops masuk ke server lewat SSH dengan kunci. Agen opsional di server melapor balik ke AI Ops lewat HTTPS bertanda tangan" viewBox="0 0 680 230">
      {(m) => (
        <>
          <Box x={10} y={64} w={220} h={100} title="AI Ops" lines={['Alamat HTTPS (PUBLIC_URL)', 'Menyimpan kunci privat']} tone="secret" />
          <Box x={450} y={64} w={220} h={100} title="Server yang dipantau" lines={['Kunci publik terpasang', 'Agen (opsional)']} tone="public" />
          <Arrow from={[232, 92]} to={[448, 92]} marker={m} />
          <Label x={340} y={80}>SSH dengan kunci</Label>
          <Label x={340} y={58}>periksa dan perbaiki</Label>
          <Arrow from={[448, 140]} to={[232, 140]} marker={m} dashed />
          <Label x={340} y={166}>HTTPS (agen melapor)</Label>
          <Label x={340} y={188}>garis putus: hanya bila agen dipasang</Label>
        </>
      )}
    </Frame>
  );
}

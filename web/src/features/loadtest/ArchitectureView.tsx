// Visualisasi arsitektur: tiap server berupa kotak, tiap komponen berupa blok berwarna menurut perannya, dan garis menunjukkan siapa memanggil siapa.
// Garis di dalam satu kotak = satu server yang sama (tanpa jaringan); garis putus-putus antar kotak = server berbeda (lewat jaringan).
import { useMemo, type CSSProperties } from 'react';
import { Badge } from '@/components/ui/Badge';
import { toneOf } from '../lab/Stage';
import type { ArchEdge, Architecture, Live, LiveService, Placement, Role, ServerBox } from './types';

export const ROLE_LABEL: Record<Role, string> = { proxy: 'Proxy / load balancer', app: 'Aplikasi', db: 'Database', cache: 'Cache', queue: 'Antrean pesan', vector: 'Vector database', search: 'Mesin pencari' };
const BW = 158, BH = 50, VG = 12, PAD = 14, HEAD = 30, GAP = 56, TG = 46, TOP_CROSS = 80, TOP_PLAIN = 22;   // ruang di atas hanya untuk garis antar server, bila ada
/** Lapisan: proxy di kiri, aplikasi di tengah, data (database, cache, antrean, ...) di kanan. */
const tierOf = (r: Role): number => (r === 'proxy' ? 0 : r === 'app' ? 1 : 2);

interface Pos { x: number; y: number; box: number; col: number }
function layout(boxes: ServerBox[], TOP: number): { pos: Map<string, Pos>; widths: number[]; xs: number[]; height: number; width: number } {
  const pos = new Map<string, Pos>(), widths: number[] = [], xs: number[] = [];
  let x = 8, maxRows = 1;
  boxes.forEach((b, i) => {
    const tiers = [...new Set(b.nodes.map((n) => tierOf(n.role)))].sort(), rows = new Map<number, number>();
    xs.push(x); const w = PAD * 2 + tiers.length * BW + (tiers.length - 1) * TG; widths.push(w);
    b.nodes.forEach((n) => { const t = tierOf(n.role), r = rows.get(t) ?? 0; rows.set(t, r + 1); maxRows = Math.max(maxRows, r + 1); const col = tiers.indexOf(t); pos.set(n.name, { x: x + PAD + col * (BW + TG), y: TOP + HEAD + r * (BH + VG), box: i, col }); });
    x += w + GAP;
  });
  return { pos, widths, xs, height: TOP + HEAD + maxRows * (BH + VG) + PAD, width: x - GAP + 8 };
}

/** Garis bergerak (tampilan langsung): durasi satu putaran dalam detik; makin banyak pengguna virtual, makin cepat. */
const flowStyle = (dur: number | undefined): CSSProperties | undefined => (dur ? ({ '--flow-dur': `${dur}s` } as CSSProperties) : undefined);
const flowDuration = (live: Live | null | undefined): number | undefined => (live ? 1.8 - 1.3 * Math.max(0.15, Math.min(1, live.vus && live.maxVus ? live.vus / live.maxVus : 0.15)) : undefined);

function Edge({ e, pos, i, dur }: { e: ArchEdge; pos: Map<string, Pos>; i: number; dur?: number | undefined }) {
  const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return null;
  const same = a.box === b.box, cls = `${same ? 'arch-edge same' : 'arch-edge cross'}${dur ? ' live' : ''}`;
  if (same) {
    if (b.col > a.col) {   // lapisan berikutnya di kanan: garis lurus melengkung dari sisi kanan ke sisi kiri
      const x1 = a.x + BW, y1 = a.y + BH / 2, x2 = b.x, y2 = b.y + BH / 2, mx = (x1 + x2) / 2;
      return <path className={cls} style={flowStyle(dur)} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} markerEnd="url(#arch-arrow)"><title>{`${e.from} ke ${e.to} (${e.label}): satu server`}</title></path>;
    }
    const x = a.x + BW, y1 = a.y + BH / 2, y2 = b.y + BH / 2, bow = 22 + (i % 2) * 6;   // lapisan yang sama: busur di sisi kanan
    return <path className={cls} style={flowStyle(dur)} d={`M ${x} ${y1} C ${x + bow} ${y1}, ${x + bow} ${y2}, ${x} ${y2}`} markerEnd="url(#arch-arrow)"><title>{`${e.from} ke ${e.to} (${e.label}): satu server`}</title></path>;
  }
  return null;   // garis antar server digambar per pasangan server oleh CrossEdge
}

interface Cross { from: number; to: number; labels: string[]; pairs: string[] }
/** Garis antar server digabung per pasangan server: satu garis, dengan keterangan jenis lalu lintasnya. */
function crossEdges(edges: ArchEdge[], pos: Map<string, Pos>): Cross[] {
  const m = new Map<string, Cross>();
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b || a.box === b.box) continue;
    const k = `${a.box}>${b.box}`, c = m.get(k) ?? { from: a.box, to: b.box, labels: [], pairs: [] };
    if (!c.labels.includes(e.label)) c.labels.push(e.label); c.pairs.push(`${e.from} ke ${e.to}`); m.set(k, c);
  }
  return [...m.values()];
}

function CrossEdge({ c, boxes, xs, widths, i, TOP, dur }: { c: Cross; boxes: ServerBox[]; xs: number[]; widths: number[]; i: number; TOP: number; dur?: number | undefined }) {
  const sx = xs[c.from]! + widths[c.from]! / 2, tx = xs[c.to]! + widths[c.to]! / 2, y = TOP - 6, lift = 16 + (i % 4) * 11, mid = (sx + tx) / 2;
  const text = c.labels.join(', ');
  return (
    <g>
      <path className={`arch-edge cross${dur ? ' live' : ''}`} style={flowStyle(dur)} d={`M ${sx} ${y} C ${sx} ${y - lift - 24}, ${tx} ${y - lift - 24}, ${tx} ${y}`} markerEnd="url(#arch-arrow)"><title>{`${boxes[c.from]!.label} ke ${boxes[c.to]!.label} (${text}): lewat jaringan antar server; ${c.pairs.join(', ')}`}</title></path>
      <text className="arch-edge-label" x={mid} y={y - (lift + 24) * 0.75 - 3} textAnchor="middle">{text}</text>
    </g>
  );
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
/** Teks tooltip pemakaian nyata satu komponen. */
const usageText = (u: LiveService): string => `CPU ${u.cpuCores.toFixed(2)} core${u.cpu != null ? ` (${pct(u.cpu)} dari kapasitasnya)` : ''}, memori ${Math.round(u.memMb)} MB${u.mem != null ? ` (${pct(u.mem)})` : ''}`;

/** Satu susunan (sekarang atau disarankan) sebagai SVG. Dengan `live`: garis bergerak, serta bilah dan angka pemakaian CPU nyata di tiap komponen. */
export function ArchitectureDiagram({ boxes, edges, label, live }: { boxes: ServerBox[]; edges: ArchEdge[]; label: string; live?: Live | null }) {
  const dur = flowDuration(live), use = useMemo(() => new Map((live?.services ?? []).map((s) => [s.service, s] as const)), [live]);
  const hasCross = useMemo(() => { const box = new Map(boxes.flatMap((b, i) => b.nodes.map((n) => [n.name, i] as const))); return edges.some((e) => box.has(e.from) && box.has(e.to) && box.get(e.from) !== box.get(e.to)); }, [boxes, edges]);
  const TOP = hasCross ? TOP_CROSS : TOP_PLAIN, L = useMemo(() => layout(boxes, TOP), [boxes, TOP]);
  return (
    <div className="arch-scroll">
      <svg role="img" aria-label={label} viewBox={`0 0 ${L.width} ${L.height}`} width={L.width} height={L.height} style={{ maxWidth: '100%', height: 'auto' }}>
        <title>{label}</title>
        <defs><marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="arch-arrowhead" /></marker></defs>
        {boxes.map((b, i) => (
          <g key={b.id}>
            <rect className="arch-server" x={L.xs[i]} y={TOP - 6} width={L.widths[i]} height={L.height - TOP + 2} rx={8} />
            <text className="arch-server-label" x={L.xs[i]! + PAD} y={TOP + 16}>{b.label}</text>
          </g>
        ))}
        {edges.map((e, i) => <Edge key={`${e.from}>${e.to}`} e={e} pos={L.pos} i={i} dur={dur} />)}
        {crossEdges(edges, L.pos).map((c, i) => <CrossEdge key={`${c.from}>${c.to}`} c={c} boxes={boxes} xs={L.xs} widths={L.widths} i={i} TOP={TOP} dur={dur} />)}
        {boxes.flatMap((b) => b.nodes.map((n) => { const p = L.pos.get(n.name)!, u = use.get(n.name), tone = u?.cpu != null ? toneOf(u.cpu) : 'none'; return (
          <g key={n.name} className={`arch-node role-${n.role}${u ? ' measured' : ''}`}>
            <rect x={p.x} y={p.y} width={BW} height={BH} rx={6} />
            <text className="arch-name" x={p.x + 10} y={p.y + 21}>{n.name.length > (u?.cpu != null ? 17 : 24) ? `${n.name.slice(0, 16)}...` : n.name}</text>
            <text className="arch-role" x={p.x + 10} y={p.y + 38}>{ROLE_LABEL[n.role]}</text>
            {u && <rect className="arch-bar-bg" x={p.x + 10} y={p.y + BH - 8} width={BW - 20} height={4} rx={2} />}
            {u && u.cpu != null && <rect className={`arch-bar ${tone}`} x={p.x + 10} y={p.y + BH - 8} width={Math.max(2, (BW - 20) * Math.min(1, u.cpu))} height={4} rx={2} />}
            {u && u.cpu != null && <text className={`arch-util ${tone}`} x={p.x + BW - 10} y={p.y + 21} textAnchor="end">{pct(u.cpu)}</text>}
            <title>{`${n.name} (${n.image})${u ? `\n${usageText(u)}` : ''}`}</title>
          </g>); }))}
      </svg>
    </div>
  );
}

const REL: Record<Placement['relation'], [Parameters<typeof Badge>[0]['tone'], string]> = { sama: ['ok', 'satu server yang sama'], beda: ['warn', 'server berbeda'], bebas: ['mute', 'bebas'] };

export function PlacementList({ placements }: { placements: Placement[] }) {
  if (!placements.length) return null;
  return (
    <div className="tbl-wrap"><table className="tbl cards" aria-label="Aturan penempatan">
      <thead><tr><th>Pasangan</th><th>Penempatan</th><th>Alasan</th></tr></thead>
      <tbody>{placements.map((p) => { const [tone, text] = REL[p.relation]; return (
        <tr key={`${p.a}-${p.b}`}>
          <td data-label="Pasangan"><strong>{ROLE_LABEL[p.a]}</strong> dan <strong>{ROLE_LABEL[p.b]}</strong></td>
          <td data-label="Penempatan"><Badge tone={tone}>{text}</Badge></td>
          <td data-label="Alasan">{p.why}{p.condition && <div className="lbl">{p.condition}</div>}</td>
        </tr>); })}</tbody>
    </table></div>
  );
}

export function Legend() {
  return (
    <div className="arch-legend" aria-label="Keterangan">
      <span className="lbl"><svg width="34" height="10" aria-hidden><line x1="1" y1="5" x2="33" y2="5" className="arch-edge same" /></svg> satu server yang sama (tanpa jaringan)</span>
      <span className="lbl"><svg width="34" height="10" aria-hidden><line x1="1" y1="5" x2="33" y2="5" className="arch-edge cross" /></svg> server berbeda (lewat jaringan)</span>
      {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <span key={r} className="lbl"><span className={`arch-swatch role-${r}`} aria-hidden /> {ROLE_LABEL[r]}</span>)}
    </div>
  );
}

/** Dua susunan berdampingan: yang diuji sekarang dan yang disarankan, beserta aturan penempatannya. */
export function ArchitectureView({ arch }: { arch: Architecture }) {
  return (
    <div className="stack">
      <div className="arch-pair">
        <div className="panel"><h3>Sekarang: {arch.current.length === 1 ? 'semua di satu server' : `${arch.current.length} server`}</h3><ArchitectureDiagram boxes={arch.current} edges={arch.edges} label="Arsitektur yang diuji sekarang" /></div>
        <div className="panel"><h3>{arch.changed ? `Disarankan: ${arch.advised.length} server` : 'Disarankan: tetap'}</h3><ArchitectureDiagram boxes={arch.advised} edges={arch.edges} label="Arsitektur yang disarankan" />
          {arch.advised.map((b) => <p key={b.id} className="lbl" style={{ margin: '4px 0' }}><b>{b.label}</b>: {b.note}</p>)}
        </div>
      </div>
      <Legend />
      {arch.notes.map((n) => <p key={n} className="lbl">{n}</p>)}
      <PlacementList placements={arch.placements} />
    </div>
  );
}

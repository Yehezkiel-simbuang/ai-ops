// Panggung visual: graf arsitektur dengan aliran request (garis putus-putus bergerak), beban tiap node (warna + bilah), dan leher botol yang berdenyut.
import { useMemo } from 'react';
import { IconBolt, IconCloud, IconDatabase, IconDisk, IconGlobe, IconList, IconNetwork, IconServer, IconSplit, IconUsers, type IconType } from '@/components/icons';
import { NODE_H, NODE_W, edgePath, layoutGraph } from './layout';
import type { LabFrame, LabNode, LabRun, NodeLoad, NodeState } from './types';

export function nodeIcon(n: LabNode): IconType {
  if (n.id === 'x-lb') return IconSplit;
  if (n.id === 'x-cdn') return IconGlobe;
  if (n.id.startsWith('x-queue-')) return IconList;
  return ({ client: IconUsers, proxy: IconNetwork, pool: IconServer, cache: IconBolt, db: IconDatabase, disk: IconDisk, external: IconCloud } as const)[n.type] ?? IconServer;
}

type Tone = 'ok' | 'warn' | 'bad' | 'none';
export const toneOf = (u: number | undefined): Tone => (u === undefined ? 'none' : u >= 0.85 ? 'bad' : u >= 0.6 ? 'warn' : 'ok');
export const fmtRate = (v: number): string => (v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '/dtk';
const STATE_TEXT: Record<NodeState, string> = { down: 'MATI', failover: 'failover...', degraded: '1 server mati', warm: 'pulih, cache dingin' };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Teks kecil di bawah nama node: pemakaian menurut jenisnya. */
function detail(n: LabNode, load: NodeLoad | undefined, inflow: number): string {
  if (load?.cap !== undefined && load.busy !== undefined) return `${load.busy}/${load.cap}${load.q ? ` · antre ${load.q}` : ''}`;
  if (n.type === 'disk' && load) return load.stalled ? 'tersendat' : `${Math.round(load.u * 100)}% sibuk${load.q ? ` · antre ${load.q}` : ''}`;
  if (n.type === 'client') return '';
  return inflow > 0 ? fmtRate(inflow) : '';
}

interface StageProps { run: LabRun; frame: LabFrame | undefined; newIds?: ReadonlySet<string>; ranks?: Record<string, number>; title: string }

export function Stage({ run, frame, newIds, ranks, title }: StageProps) {
  const layout = useMemo(() => layoutGraph(run.arch.nodes, run.edges), [run.arch.nodes, run.edges]);
  const diag = frame ? run.diags[frame.diag] : undefined, hot = diag && diag.lv >= 1 ? diag.node : null;
  const inflow = useMemo(() => {
    const m: Record<string, number> = {};
    if (frame) for (const [k, v] of Object.entries(frame.flows)) { const to = k.split('>')[1]!; m[to] = (m[to] ?? 0) + v; }
    return m;
  }, [frame]);

  return (
    <div className="stage-box">
    <p className="lbl swipe-hint">Geser ke samping untuk melihat seluruh diagram.</p>
    <div className="stage-wrap">
    <svg className="stage" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`Diagram arsitektur: ${title}`} preserveAspectRatio="xMidYMid meet">
      {run.edges.map(([a, b]) => {
        const pa = layout.placed[a], pb = layout.placed[b]; if (!pa || !pb) return null;
        const flow = frame?.flows[`${a}>${b}`] ?? 0, tone = toneOf(frame?.nodes[b]?.u);
        const live = flow > 0.05, w = 1.2 + Math.min(4, Math.log10(1 + flow) * 1.7), dur = Math.max(0.3, 1.6 - Math.log10(1 + flow) * 0.5);
        const mx = (pa.x + NODE_W + pb.x) / 2, my = (pa.y + pb.y + NODE_H) / 2;
        return (
          <g key={`${a}>${b}`}>
            <path d={edgePath(pa, pb)} className={`edge ${live ? `live ${tone}` : ''}`} style={{ strokeWidth: live ? w : 1.2, ['--dur' as string]: `${dur}s` }} />
            {flow >= 0.1 && <text x={mx} y={my - 5} className="edge-label" textAnchor="middle">{fmtRate(flow)}</text>}
          </g>
        );
      })}
      {Object.values(layout.placed).map(({ node, x, y }) => {
        const load = frame?.nodes[node.id], state = frame?.states?.[node.id], Icon = nodeIcon(node), isNew = newIds?.has(node.id), isHot = hot === node.id;
        const tone: Tone = state === 'down' || state === 'failover' ? 'bad' : state ? 'warn' : toneOf(load?.u);
        const sub = state ? STATE_TEXT[state] : detail(node, load, inflow[node.id] ?? 0);
        return (
          <g key={node.id} transform={`translate(${x},${y})`} className={`gnode ${tone}${isNew ? ' new' : ''}${isHot ? ' hot' : ''}${state ? ` st-${state}` : ''}`} data-node={node.id} data-tone={tone} data-state={state}>
            <title>{node.label ?? node.id}</title>
            <rect width={NODE_W} height={NODE_H} rx={9} className="gbox" />
            <g transform="translate(10,11)" className="gicon"><Icon size={18} aria-hidden /></g>
            <text x={34} y={23} className="glabel">{clip(node.label ?? node.id, 17)}</text>
            <text x={34} y={39} className="gsub">{sub}</text>
            {load && <><rect x={10} y={NODE_H - 11} width={NODE_W - 20} height={4} rx={2} className="gtrack" /><rect x={10} y={NODE_H - 11} width={Math.max(0, (NODE_W - 20) * load.u)} height={4} rx={2} className="gfill" /></>}
            {ranks?.[node.id] && <g className="grank-badge"><circle cx={0} cy={0} r={10} className="grank" /><text x={0} y={3.5} textAnchor="middle" className="grank-t">{ranks[node.id]}</text></g>}
            {isNew && <text x={NODE_W - 8} y={14} className="gnew" textAnchor="end">baru</text>}
          </g>
        );
      })}
    </svg>
    </div>
    </div>
  );
}

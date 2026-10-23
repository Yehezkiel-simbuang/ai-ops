// Tata letak graf arsitektur: kolom menurut kedalaman dari klien (klien -> proxy/LB -> server -> cache/database -> disk), baris menurut urutan node.
import type { LabNode } from './types';

export const NODE_W = 148, NODE_H = 58, COL_GAP = 54, ROW_GAP = 18, PAD = 14;

export interface Placed { node: LabNode; x: number; y: number }
export interface GraphLayout { placed: Record<string, Placed>; width: number; height: number }

/** Kedalaman tiap node = jarak terpendek dari node klien lewat sambungan. Node yang tak terjangkau diletakkan di kolom 0. */
export function depths(nodes: LabNode[], edges: Array<[string, string]>): Record<string, number> {
  const depth: Record<string, number> = {}, next: Record<string, string[]> = {};
  edges.forEach(([a, b]) => { (next[a] ||= []).push(b); });
  const queue: string[] = [];
  nodes.filter((n) => n.type === 'client').forEach((n) => { depth[n.id] = 0; queue.push(n.id); });
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of next[id] ?? []) if (depth[to] === undefined) { depth[to] = depth[id]! + 1; queue.push(to); }
  }
  nodes.forEach((n) => { depth[n.id] ??= 0; });
  return depth;
}

export function layoutGraph(nodes: LabNode[], edges: Array<[string, string]>): GraphLayout {
  const depth = depths(nodes, edges), cols: LabNode[][] = [];
  nodes.forEach((n) => { (cols[depth[n.id]!] ||= []).push(n); });
  const rows = Math.max(1, ...cols.map((c) => c?.length ?? 0)), innerH = rows * NODE_H + (rows - 1) * ROW_GAP;
  const placed: Record<string, Placed> = {};
  cols.forEach((col, ci) => {
    if (!col) return;
    const colH = col.length * NODE_H + (col.length - 1) * ROW_GAP, top = PAD + (innerH - colH) / 2;
    col.forEach((node, ri) => { placed[node.id] = { node, x: PAD + ci * (NODE_W + COL_GAP), y: top + ri * (NODE_H + ROW_GAP) }; });
  });
  return { placed, width: PAD * 2 + cols.length * NODE_W + (cols.length - 1) * COL_GAP, height: PAD * 2 + innerH };
}

/** Kurva dari sisi kanan node asal ke sisi kiri node tujuan. */
export function edgePath(a: Placed, b: Placed): string {
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, dx = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

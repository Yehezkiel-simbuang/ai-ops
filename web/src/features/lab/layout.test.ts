import { NODE_H, NODE_W, depths, edgePath, layoutGraph } from './layout';
import { run } from './fixtures';

describe('tata letak graf', () => {
  const r = run();
  it('kedalaman: klien 0, lalu tiap langkah sambungan', () => {
    expect(depths(r.arch.nodes, r.edges)).toEqual({ users: 0, gw: 1, api: 2, pg: 3, ssd: 4 });
  });
  it('node yang tak terjangkau dari klien diletakkan di kolom 0', () => {
    expect(depths([...r.arch.nodes, { id: 'yatim', type: 'cache' }], r.edges).yatim).toBe(0);
  });
  it('kolom bertambah ke kanan dan tidak ada dua node di tempat yang sama', () => {
    const g = layoutGraph(r.arch.nodes, r.edges), xs = Object.values(g.placed).map((p) => p.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(Object.values(g.placed).map((p) => `${p.x},${p.y}`)).size).toBe(5);
    expect(g.width).toBeGreaterThan(0); expect(g.height).toBeGreaterThan(0);
  });
  it('replika sekolom dengan primary dan tidak bertumpuk', () => {
    const nodes = [...r.arch.nodes, { id: 'x-replica-pg', type: 'db' as const, label: 'Replika' }];
    const g = layoutGraph(nodes, [...r.edges, ['api', 'x-replica-pg']]);
    expect(g.placed['x-replica-pg']!.x).toBe(g.placed.pg!.x); expect(g.placed['x-replica-pg']!.y).not.toBe(g.placed.pg!.y);
  });
  it('kurva berawal di sisi kanan node asal dan berakhir di sisi kiri node tujuan', () => {
    const g = layoutGraph(r.arch.nodes, r.edges), d = edgePath(g.placed.users!, g.placed.gw!);
    expect(d.startsWith(`M ${g.placed.users!.x + NODE_W} `)).toBe(true); expect(d.endsWith(` ${g.placed.gw!.x} ${g.placed.gw!.y + NODE_H / 2}`)).toBe(true);
  });
});

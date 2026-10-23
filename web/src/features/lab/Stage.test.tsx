import { render } from '@testing-library/react';
import { run } from './fixtures';
import { Stage, fmtRate, toneOf } from './Stage';

const nodeEl = (c: HTMLElement, id: string) => c.querySelector(`[data-node="${id}"]`)!;

describe('Stage', () => {
  it('menggambar semua node dengan nama, dan warna menurut pemakaian', () => {
    const r = run(), { container } = render(<Stage run={r} frame={r.frames[0]} title="Eksperimen" />);
    for (const label of ['Pengguna', 'Gateway', 'Server API', 'Postgres', 'SSD']) expect(container.textContent).toContain(label);
    expect(nodeEl(container, 'api').getAttribute('data-tone')).toBe('ok');      // 0.3
    expect(nodeEl(container, 'pg').getAttribute('data-tone')).toBe('warn');     // 0.7
    expect(nodeEl(container, 'ssd').getAttribute('data-tone')).toBe('bad');     // 0.95
    expect(nodeEl(container, 'users').getAttribute('data-tone')).toBe('none');  // tanpa data beban
    expect(container.textContent).toContain('6/20');                            // busy/cap pool
    expect(container.textContent).toContain('antre 4');                         // antrean disk
  });
  it('aliran: hanya sambungan yang dilewati request yang bergerak dan berlabel', () => {
    const r = run({}, { flows: { 'users>gw': 40, 'gw>api': 0 } }), { container } = render(<Stage run={r} frame={r.frames[0]} title="x" />);
    const live = container.querySelectorAll('path.edge.live');
    expect(live).toHaveLength(1);
    expect(container.textContent).toContain('40/dtk');
  });
  it('leher botol dari diagnosis berdenyut; node baru ditandai', () => {
    const r = run({}, { diag: 1 }), { container } = render(<Stage run={r} frame={r.frames[0]} newIds={new Set(['pg'])} title="x" />);
    expect(nodeEl(container, 'ssd').classList.contains('hot')).toBe(true);
    expect(nodeEl(container, 'api').classList.contains('hot')).toBe(false);
    expect(nodeEl(container, 'pg').classList.contains('new')).toBe(true); expect(nodeEl(container, 'pg').textContent).toContain('baru');
  });
  it('tanpa bingkai tetap menggambar bentuknya (tanpa aliran)', () => {
    const { container } = render(<Stage run={run()} frame={undefined} title="x" />);
    expect(container.querySelectorAll('[data-node]')).toHaveLength(5); expect(container.querySelectorAll('path.edge.live')).toHaveLength(0);
  });
  it('node yang mati, failover, atau degradasi ditandai dan diberi teks', () => {
    const r = run({}, { states: { pg: 'down', api: 'degraded', ssd: 'failover' } }), { container } = render(<Stage run={r} frame={r.frames[0]} title="x" />);
    expect(nodeEl(container, 'pg').getAttribute('data-state')).toBe('down'); expect(nodeEl(container, 'pg').getAttribute('data-tone')).toBe('bad'); expect(nodeEl(container, 'pg').textContent).toContain('MATI');
    expect(nodeEl(container, 'api').getAttribute('data-tone')).toBe('warn'); expect(nodeEl(container, 'api').textContent).toContain('1 server mati');
    expect(nodeEl(container, 'ssd').textContent).toContain('failover');
    expect(nodeEl(container, 'users').getAttribute('data-state')).toBeNull();
  });
  it('toneOf dan fmtRate', () => {
    expect([toneOf(undefined), toneOf(0.2), toneOf(0.6), toneOf(0.85)]).toEqual(['none', 'ok', 'warn', 'bad']);
    expect([fmtRate(0.5), fmtRate(12.3), fmtRate(250)]).toEqual(['0.5/dtk', '12/dtk', '250/dtk']);
  });
});

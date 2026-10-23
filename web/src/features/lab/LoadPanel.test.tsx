import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoadPanel } from './LoadPanel';
import { initialScenario } from './scenario';
import { project, load } from './fixtures';
import type { LabProject } from './types';

const withNodes: LabProject = { ...project, arch: { workloads: [], nodes: [{ id: 'users', type: 'client', label: 'Pengguna' }, { id: 'api', type: 'pool', label: 'Server API' }, { id: 'pg', type: 'db', label: 'Postgres' }, { id: 'gw', type: 'proxy', label: 'Gateway' }] } };
const props = () => ({ onLoad: vi.fn(), onSeconds: vi.fn(), onFaults: vi.fn(), onFailure: vi.fn() });

describe('LoadPanel: skenario kegagalan', () => {
  it('mengaktifkan memilih database sebagai target bawaan, dan hanya komponen yang bisa mati yang ditawarkan', async () => {
    const p = props();
    render(<LoadPanel scenario={{ ...initialScenario(withNodes, 'now'), seconds: 120 }} project={withNodes} {...p} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /Skenario kegagalan/ }));
    expect(p.onFailure).toHaveBeenCalledWith({ node: 'pg', at: 30, len: 40 });
  });
  it('saat aktif: memilih komponen lain dan mengubah waktu', () => {
    const p = props(), scenario = { ...initialScenario(withNodes, 'now'), failure: { node: 'pg', at: 30, len: 40 } };
    render(<LoadPanel scenario={scenario} project={withNodes} {...p} />);
    const select = screen.getByRole('combobox', { name: 'Komponen yang mati' }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['api', 'pg']);   // klien dan proxy tidak ditawarkan
    fireEvent.change(select, { target: { value: 'api' } });
    expect(p.onFailure).toHaveBeenLastCalledWith({ node: 'api', at: 30, len: 40 });
    fireEvent.change(screen.getByLabelText('Mulai (detik)'), { target: { value: '55' } });
    expect(p.onFailure).toHaveBeenLastCalledWith({ node: 'pg', at: 55, len: 40 });
    expect(screen.getByText(/titik|Tanpa cadangan/)).toBeInTheDocument();
  });
  it('mematikan skenario kegagalan mengirim null', async () => {
    const p = props();
    render(<LoadPanel scenario={{ ...initialScenario(withNodes, 'now'), failure: { node: 'pg', at: 30, len: 40 } }} project={withNodes} {...p} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /Skenario kegagalan/ }));
    expect(p.onFailure).toHaveBeenCalledWith(null);
    void load;
  });
});

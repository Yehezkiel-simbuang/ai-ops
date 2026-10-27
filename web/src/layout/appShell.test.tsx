import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { Overview } from '@/api/types';
import { mockApi, renderWithProviders } from '@/test/utils';
import { AppShell, pageTitle } from './AppShell';

afterEach(() => vi.unstubAllGlobals());

const overview = (over: Partial<Overview> = {}): Overview => ({ servers: [], pending: [], incidents: [], recsWaiting: 0, maintenance: { overdue: 0, soon: 0 }, rotationDue: 0, runs: [], usage: { input: 0, output: 0, calls: 0, cost: 0, costKnown: true }, alerts: [], setupReady: true, monitorReady: true, ...over });
const render = (o: Overview = overview(), route = '/monitor') => {
  mockApi({ 'GET /api/overview': { body: o } });
  renderWithProviders(<Routes><Route element={<AppShell />}><Route path="/monitor" element={<div>halaman monitor</div>} /><Route path="/server" element={<div>halaman server</div>} /></Route></Routes>, { route });
};

describe('pageTitle', () => {
  it('nama halaman dari alamat, termasuk sub-halaman; tak dikenal memakai nama aplikasi', () => {
    expect(pageTitle('/monitor')).toBe('Monitor'); expect(pageTitle('/monitor/3')).toBe('Monitor'); expect(pageTitle('/uji-beban/banding')).toBe('Uji beban'); expect(pageTitle('/entah')).toBe('AI Ops');
  });
});

describe('AppShell', () => {
  it('menu dikelompokkan dan halaman aktif ditandai; bilah atas memuat nama halaman', async () => {
    render();
    const nav = screen.getByRole('navigation', { name: 'Navigasi utama' });
    expect(within(nav).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Pantau', 'Kelola', 'Uji', 'Lainnya']);
    expect(within(nav).getByRole('link', { name: /Monitor/ })).toHaveClass('active'); expect(within(nav).getByRole('link', { name: /Server/ })).not.toHaveClass('active');
    expect(screen.getByRole('banner')).toHaveTextContent('Monitor');
  });

  it('tombol menu membuka dan menutup; memilih halaman menutupnya; Escape juga menutup', async () => {
    render();
    const btn = screen.getByRole('button', { name: 'Buka menu' }), nav = screen.getByRole('navigation', { name: 'Navigasi utama' });
    expect(btn).toHaveAttribute('aria-expanded', 'false'); expect(nav).not.toHaveClass('open');
    await userEvent.click(btn); expect(screen.getByRole('button', { name: 'Tutup menu' })).toHaveAttribute('aria-expanded', 'true'); expect(nav).toHaveClass('open');
    await userEvent.click(within(nav).getByRole('link', { name: /Server/ }));
    expect(await screen.findByText('halaman server')).toBeInTheDocument(); expect(nav).not.toHaveClass('open'); expect(screen.getByRole('banner')).toHaveTextContent('Server');
    await userEvent.click(screen.getByRole('button', { name: 'Buka menu' })); expect(nav).toHaveClass('open'); await userEvent.keyboard('{Escape}'); expect(nav).not.toHaveClass('open');
  });

  it('persetujuan menunggu dan proses yang gagal menambah angka di menu Setup dan di judul tab', async () => {
    const pend = { id: 1, run_id: 'r1', run_name: 'x', command: 'ufw enable', purpose: '', reason: '' };
    render(overview({ pending: [pend], runs: [{ id: 'r2', status: 'needs_attention' } as never] }));
    const nav = screen.getByRole('navigation', { name: 'Navigasi utama' });
    expect(await within(nav).findByRole('link', { name: /Setup\s*2/ })).toBeInTheDocument();
    expect(document.title).toMatch(/^\(2\) Perlu tindakan/);
  });

  it('tanpa yang menunggu, tidak ada angka di Setup dan judul tab biasa', async () => {
    render(); await screen.findByText('halaman monitor');
    expect(within(screen.getByRole('navigation', { name: 'Navigasi utama' })).getByRole('link', { name: 'Setup' })).toBeInTheDocument(); expect(document.title).not.toMatch(/Perlu tindakan/);
  });

  it('menyentuh latar di belakang menu menutupnya', async () => {
    const { container } = (render(), { container: document.body });
    await userEvent.click(screen.getByRole('button', { name: 'Buka menu' }));
    const scrim = container.querySelector('.scrim') as HTMLElement; expect(scrim).toBeTruthy(); await userEvent.click(scrim);
    expect(screen.getByRole('navigation', { name: 'Navigasi utama' })).not.toHaveClass('open'); expect(container.querySelector('.scrim')).toBeNull();
  });

  it('jumlah yang butuh perhatian muncul di tombol menu saat tertutup, supaya tidak terlewat di layar kecil', async () => {
    render(overview({ alerts: [{ id: 1, title: 'a', detail: '', level: 'critical', ts: 1, resolved: false, acked: false }, { id: 2, title: 'b', detail: '', level: 'major', ts: 1, resolved: false, acked: false }] }));
    expect(await within(screen.getByRole('button', { name: 'Buka menu' })).findByText('2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Buka menu' })); expect(within(screen.getByRole('button', { name: 'Tutup menu' })).queryByText('2')).not.toBeInTheDocument();
  });
});

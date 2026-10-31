import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Menu } from './Menu';

describe('Menu aksi lain', () => {
  const setup = (hidden = false) => { const hapus = vi.fn(); render(<div><Menu label="Aksi lain x" items={[{ label: 'Ubah', onSelect: () => {} }, { label: 'Kunci', hidden, onSelect: () => {} }, { label: 'Hapus', danger: true, onSelect: hapus }]} /><p>luar</p></div>); return hapus; };
  it('tertutup sampai dibuka; memilih aksi memanggilnya lalu menutup daftar', async () => {
    const hapus = setup(); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Aksi lain x' })); expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Hapus' })); expect(hapus).toHaveBeenCalledOnce(); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('tertutup oleh Esc dan klik di luar; aksi tersembunyi tidak tampil', async () => {
    setup(true); const btn = screen.getByRole('button', { name: 'Aksi lain x' });
    await userEvent.click(btn); expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Ubah', 'Hapus']);
    await userEvent.keyboard('{Escape}'); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await userEvent.click(btn); await userEvent.click(screen.getByText('luar')); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

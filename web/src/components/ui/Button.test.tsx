import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '../Toaster';
import { Button } from './Button';

describe('Button', () => {
  it('terkunci selama aksi async berjalan lalu aktif lagi', async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    render(<Button onClick={action}>Simpan</Button>);
    const btn = screen.getByRole('button', { name: 'Simpan' });
    await userEvent.click(btn);
    expect(btn).toBeDisabled();
    await userEvent.click(btn);            // klik ganda diabaikan
    expect(action).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(btn).toBeEnabled());
  });
  it('aksi yang gagal: tombol aktif lagi, galat ditampilkan, dan tidak ada unhandled rejection', async () => {
    const unhandled = vi.fn(); window.addEventListener('unhandledrejection', unhandled);
    render(<><Button onClick={() => Promise.reject(new Error('Password salah'))}>Coba</Button><Toaster /></>);
    const btn = screen.getByRole('button', { name: 'Coba' });
    await userEvent.click(btn);
    expect(await screen.findByRole('status')).toHaveTextContent('Password salah');
    await waitFor(() => expect(btn).toBeEnabled());
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', unhandled);
  });
});

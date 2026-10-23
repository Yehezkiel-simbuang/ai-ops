import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button } from '../ui/Button';
import { renderWithProviders } from '@/test/utils';
import { useDialogs } from './DialogProvider';

function Harness() {
  const { confirm, askPassword, showSecret } = useDialogs();
  const [out, setOut] = useState('');
  return (
    <>
      <Button onClick={async () => setOut(String(await confirm('Hapus server ini?', 'Hapus')))}>uji-confirm</Button>
      <Button onClick={async () => setOut(String(await askPassword('Masukkan password')))}>uji-password</Button>
      <Button onClick={() => showSecret('Rahasia', 'catatan', 'S3cr3t-value')}>uji-secret</Button>
      <output aria-label="hasil">{out}</output>
    </>
  );
}

describe('DialogProvider', () => {
  it('confirm menghasilkan true saat dikonfirmasi dan false saat dibatalkan', async () => {
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByText('uji-confirm'));
    expect(await screen.findByText('Hapus server ini?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hapus' }));
    await waitFor(() => expect(screen.getByLabelText('hasil')).toHaveTextContent('true'));

    await userEvent.click(screen.getByText('uji-confirm'));
    await userEvent.click(await screen.findByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.getByLabelText('hasil')).toHaveTextContent('false'));
  });
  it('askPassword mengembalikan teks yang diketik, dan null bila dibatalkan', async () => {
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByText('uji-password'));
    await userEvent.type(await screen.findByLabelText('Password akun Anda'), 'rahasia-saya');
    await userEvent.click(screen.getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(screen.getByLabelText('hasil')).toHaveTextContent('rahasia-saya'));

    await userEvent.click(screen.getByText('uji-password'));
    await userEvent.click(await screen.findByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.getByLabelText('hasil')).toHaveTextContent('null'));
  });
  it('showSecret menampilkan rahasia dan menutup dengan tombol', async () => {
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByText('uji-secret'));
    expect(await screen.findByText('S3cr3t-value')).toBeInTheDocument();
    expect(screen.getByText(/Disembunyikan otomatis dalam 30 detik/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Tutup' }));
    await waitFor(() => expect(screen.queryByText('S3cr3t-value')).not.toBeInTheDocument());
  });
});

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import type { Incident, SimilarIncident } from '@/api/types';
import { CloseButton, NotesPanel, Similar } from './SolutionBook';

const inc = (over: Partial<Incident> = {}): Incident => ({ id: 7, title: 'Disk penuh', detail: '', server_name: 'srv-a', opened: Date.now(), status: 'open', event_count: 1, rec_status: null, cause: '', solution: '', ...over });
const sim = (over: Partial<SimilarIncident> = {}): SimilarIncident => ({ id: 2, server_name: 'srv-b', title: 'Disk penuh', opened: Date.now(), resolved_at: Date.now(), cause: 'Log membengkak', solution: 'Bersihkan /var/log', noted_by: 'admin', closed_by: null, closed_reason: null, score: 2, worked: [], ...over });
afterEach(() => vi.unstubAllGlobals());

describe('buku solusi', () => {
  it('catatan: tombol simpan baru aktif setelah diubah, lalu mengirim penyebab dan penyelesaian', async () => {
    const calls = mockApi({ 'PUT /api/incidents/7/notes': { body: {} } });
    renderWithProviders(<NotesPanel inc={inc()} />);
    const save = screen.getByRole('button', { name: /Simpan catatan/ }); expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Penyebab'), 'Server di-restart'); await userEvent.type(screen.getByLabelText('Penyelesaian'), 'docker compose up -d');
    expect(save).toBeEnabled(); await userEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ cause: 'Server di-restart', solution: 'docker compose up -d' }));
  });
  it('insiden serupa: menampilkan penyebab, penyelesaian, asal, dan perbaikan yang dulu berhasil; kosong = tidak tampil', () => {
    renderWithProviders(<Similar items={[sim({ worked: [{ title: 'Jalankan ulang nginx', command: 'sudo systemctl restart nginx' }] })]} />);
    expect(screen.getByText(/Penyebab: Log membengkak/)).toBeInTheDocument(); expect(screen.getByText(/Penyelesaian: Bersihkan \/var\/log/)).toBeInTheDocument();
    expect(screen.getByText(/kunci sama di server lain/)).toBeInTheDocument(); expect(screen.getByText(/Jalankan ulang nginx \(sudo systemctl restart nginx\)/)).toBeInTheDocument();
  });
  it('tanpa insiden serupa bagian itu tidak tampil', () => { const { container } = renderWithProviders(<Similar items={[]} />); expect(container.querySelector('section')).toBeNull(); });
  it('tombol tutup manual hanya untuk insiden terbuka', () => {
    renderWithProviders(<CloseButton inc={inc()} />); expect(screen.getByRole('button', { name: /Tutup manual/ })).toBeInTheDocument();
  });
  it('insiden yang sudah pulih tidak punya tombol tutup', () => {
    renderWithProviders(<CloseButton inc={inc({ status: 'resolved' })} />); expect(screen.queryByRole('button', { name: /Tutup manual/ })).not.toBeInTheDocument();
  });
});

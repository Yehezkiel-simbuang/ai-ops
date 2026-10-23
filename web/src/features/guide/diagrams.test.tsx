import { render, screen } from '@testing-library/react';
import { AgentFlow, KeyMap, KeyPair } from './diagrams';

describe('diagram panduan', () => {
  it('tiap diagram punya nama yang menjelaskan isinya dan memuat label langkah', () => {
    const { unmount } = render(<KeyMap />);
    expect(screen.getByRole('img', { name: /kunci privat ditempel ke AI Ops, kunci publik dipasang di server/ })).toBeInTheDocument();
    for (const t of ['1. tempel kunci privat', '2. pasang kunci publik', '3. login SSH', 'Komputer Anda', 'Server yang dipantau']) expect(screen.getByText(t)).toBeInTheDocument();
    unmount();
    const pair = render(<KeyPair />);
    expect(screen.getByText('aiops_key (PRIVAT)')).toBeInTheDocument(); expect(screen.getByText('aiops_key.pub (PUBLIK)')).toBeInTheDocument(); pair.unmount();
    render(<AgentFlow />);
    expect(screen.getByText('SSH dengan kunci')).toBeInTheDocument(); expect(screen.getByText('HTTPS (agen melapor)')).toBeInTheDocument();
  });
  it('penanda panah unik per diagram agar beberapa diagram di satu halaman tidak saling menimpa', () => {
    const { container } = render(<><KeyMap /><KeyPair /></>);
    const ids = Array.from(container.querySelectorAll('marker')).map((m) => m.id);
    expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
  });
});

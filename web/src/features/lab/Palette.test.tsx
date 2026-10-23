import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog } from './fixtures';
import { Palette } from './Palette';
import { componentAction } from './scenario';

describe('Palette', () => {
  it('komponen yang tidak berlaku diberi alasan dan tidak bisa dibuka', async () => {
    render(<Palette catalog={catalog} actions={[]} onApply={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Disk sudah secepat SSD NVMe.')).toBeInTheDocument();
    expect(screen.getByText('tidak berlaku')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Pindah ke SSD NVMe'));
    expect(screen.queryByRole('button', { name: 'Pasang' })).not.toBeInTheDocument();
  });

  it('memasang komponen dengan parameter yang diubah', async () => {
    const onApply = vi.fn();
    render(<Palette catalog={catalog} actions={[]} onApply={onApply} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByText('Cache Redis'));
    const slider = screen.getByRole('slider', { name: 'Hit ratio' });
    expect(slider).toHaveValue('85');
    fireEvent.change(slider, { target: { value: '87' } });   // jsdom tidak menggerakkan slider lewat keyboard
    await userEvent.click(screen.getByRole('button', { name: 'Pasang' }));
    expect(onApply).toHaveBeenCalledWith('redis', { hit: 87 });
  });

  it('komponen terpasang ditandai, bisa diperbarui dan dilepas', async () => {
    const onApply = vi.fn(), onRemove = vi.fn();
    render(<Palette catalog={catalog} actions={[componentAction('redis', { hit: 92 })]} onApply={onApply} onRemove={onRemove} />);
    expect(screen.getByText('terpasang')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Cache Redis'));
    expect(screen.getByRole('slider', { name: 'Hit ratio' })).toHaveValue('92');
    await userEvent.click(screen.getByRole('button', { name: 'Lepas' }));
    expect(onRemove).toHaveBeenCalledWith('redis');
  });

  it('komponen bertarget: memilih target lain menambah, bukan menimpa; opsi select dari arsitektur', async () => {
    const onApply = vi.fn();
    render(<Palette catalog={catalog} actions={[]} onApply={onApply} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByText('Replika baca database'));
    const db = screen.getByRole('combobox'); expect(Array.from((db as HTMLSelectElement).options).map((o) => o.value)).toEqual(['pg', 'pg2']);
    await userEvent.selectOptions(db, 'pg2');
    await userEvent.click(screen.getByRole('button', { name: 'Pasang' }));
    expect(onApply).toHaveBeenCalledWith('replica', { db: 'pg2', share: 80 });
  });
});

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, renderWithProviders } from '@/test/utils';
import { BUILDER_DEFAULT, BuilderPanel, builderPayload } from './BuilderPanel';

afterEach(() => vi.unstubAllGlobals());

describe('builderPayload', () => {
  it('kolom kosong tidak dikirim; batas dan komponen opsional ikut bila diisi', () => {
    expect(builderPayload({ ...BUILDER_DEFAULT, image: ' x:1 ' })).toEqual({ app: { image: 'x:1', port: 80, replicas: 1, limits: {}, healthPath: '' }, db: null, redis: null, lb: 'nginx', publishPort: 8080 });
    const p = builderPayload({ ...BUILDER_DEFAULT, image: 'x:1', replicas: 2, db: 'postgres', redis: true, cpus: '0.5', memory: '512m', dbMemory: '1g' });
    expect(p.app.limits).toEqual({ cpus: 0.5, memory: '512m' }); expect(p.db).toEqual({ kind: 'postgres', limits: { memory: '1g' } }); expect(p.redis).toEqual({});
  });
});

describe('BuilderPanel', () => {
  it('Buat Compose terkunci tanpa image; lalu mengirim dan menyerahkan hasilnya', async () => {
    const calls = mockApi({ 'POST /api/playground/build': { body: { compose: 'services: {}', analysis: {} } } }); const built = vi.fn();
    renderWithProviders(<BuilderPanel onBuilt={built} onClose={() => undefined} />);
    const btn = screen.getByRole('button', { name: 'Buat Compose' }); expect(btn).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/ghcr.io/), 'x:1'); await userEvent.selectOptions(screen.getByLabelText('Database'), 'mysql'); await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(btn);
    await waitFor(() => expect(built).toHaveBeenCalledWith('services: {}', ''));
    expect(calls[0]!.body).toMatchObject({ app: { image: 'x:1' }, db: { kind: 'mysql' }, redis: {} });
  });
});

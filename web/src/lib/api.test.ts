import { ApiError, api, onUnauthorized, qs } from './api';
import { mockApi } from '@/test/utils';

afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('mengirim header X-AIOps dan badan JSON', async () => {
    const calls = mockApi({ 'POST /api/x': { body: { ok: true } } });
    await api('POST', '/api/x', { a: 1 });
    expect(calls[0]!.headers['x-aiops']).toBe('1');
    expect(calls[0]!.body).toEqual({ a: 1 });
  });
  it('galat server menjadi ApiError berpesan dari server', async () => {
    mockApi({ 'GET /api/x': { status: 400, body: { error: 'Nama wajib diisi' } } });
    await expect(api('GET', '/api/x')).rejects.toMatchObject({ name: 'ApiError', status: 400, message: 'Nama wajib diisi' });
    expect(new ApiError(500, 'x')).toBeInstanceOf(Error);
  });
  it('401 di luar login/me memicu peristiwa sesi berakhir', async () => {
    mockApi({ 'GET /api/overview': { status: 401, body: { error: 'Belum masuk' } }, 'GET /api/me': { status: 401, body: { error: 'Belum masuk' } } });
    const seen = vi.fn(); const off = onUnauthorized(seen);
    await api('GET', '/api/me').catch(() => undefined); expect(seen).not.toHaveBeenCalled();
    await api('GET', '/api/overview').catch(() => undefined); expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
  it('qs melewati nilai kosong dan meng-encode', () => {
    expect(qs({ q: 'a b', env: '', n: 0, x: undefined })).toBe('?q=a+b&n=0');
    expect(qs({})).toBe('');
  });
});

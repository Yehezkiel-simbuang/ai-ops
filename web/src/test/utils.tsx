import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { DialogProvider } from '@/components/dialogs/DialogProvider';
import { Toaster } from '@/components/Toaster';
import { MutationCache } from '@tanstack/react-query';
import { toast } from '@/lib/toast';

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    mutationCache: new MutationCache({ onError: (e) => toast(e.message, true) })
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}><DialogProvider>{ui}<Toaster /></DialogProvider></MemoryRouter>
    </QueryClientProvider>
  );
  return { ...view, client };
}

type Reply = { status?: number; body: unknown } | ((url: string, init?: RequestInit) => { status?: number; body: unknown });

/** Palsukan fetch: kunci "METODE /jalur" -> jawaban JSON. Mengembalikan daftar panggilan untuk diperiksa. */
export function mockApi(routes: Record<string, Reply>) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET', key = `${method} ${url}`;
    calls.push({ method, path: url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: `tidak ada mock untuk ${key}` }), { status: 500 });
    const r = typeof route === 'function' ? route(url, init) : route;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  vi.stubGlobal('fetch', vi.fn(impl));
  return calls;
}

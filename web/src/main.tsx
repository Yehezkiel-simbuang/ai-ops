import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ApiError } from './lib/api';
import { toast } from './lib/toast';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/lab.css';

const client = new QueryClient({
  defaultOptions: { queries: { retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2, refetchOnWindowFocus: false } },
  mutationCache: new MutationCache({ onError: (e) => toast(e.message, true) })
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter><App /></BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);

import { queryOptions } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { Architecture, LoadTestDetail, LoadTestListItem, LoadTestStatus, TestStatus } from './types';

const ACTIVE: TestStatus[] = ['queued', 'running'];
export const isActive = (s: TestStatus | undefined): boolean => !!s && ACTIVE.includes(s);

export const loadQ = {
  /** Susunan Playground yang akan diuji dan arsitekturnya, untuk pratinjau di formulir uji baru. */
  preview: (pg: number) => queryOptions({ queryKey: ['loadtests', 'preview', pg], queryFn: () => get<{ setup: { name: string }; architecture: Architecture } | null>(`/api/loadtests/preview?playground=${pg}`), staleTime: 30_000 }),
  status: () => queryOptions({ queryKey: ['loadtests', 'status'], queryFn: () => get<LoadTestStatus>('/api/loadtests/status'), refetchInterval: 10_000 }),
  list: () => queryOptions({ queryKey: ['loadtests', 'list'], queryFn: () => get<LoadTestListItem[]>('/api/loadtests'), refetchInterval: (q) => (q.state.data?.some((t) => isActive(t.status)) ? 2000 : 8000) }),
  /** Segar tiap 2 detik selama antre/berjalan, supaya hasil tiap tahap muncul begitu dilaporkan. */
  detail: (id: number) => queryOptions({ queryKey: ['loadtests', 'detail', id], queryFn: () => get<LoadTestDetail>(`/api/loadtests/${id}`), refetchInterval: (q) => (isActive(q.state.data?.status) || q.state.data?.ai?.status === 'running' ? 2000 : false) })
};

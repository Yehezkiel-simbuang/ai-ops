import { queryOptions } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { WebCheck } from './types';

export const webQ = {
  list: () => queryOptions({ queryKey: ['webchecks', 'list'], queryFn: () => get<WebCheck[]>('/api/webchecks'), refetchInterval: 10_000 })
};

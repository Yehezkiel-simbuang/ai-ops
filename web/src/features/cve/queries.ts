import { queryOptions } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { CveLookup, CveWatch } from './types';

export const CVE_RE = /^CVE-\d{4}-\d{4,7}$/i;
export const cveQ = {
  lookup: (id: string) => queryOptions({ queryKey: ['cve', 'lookup', id.toUpperCase()], queryFn: () => get<CveLookup>(`/api/cve/${encodeURIComponent(id.toUpperCase())}`), staleTime: 60_000, retry: false }),
  watches: () => queryOptions({ queryKey: ['cve', 'watches'], queryFn: () => get<CveWatch[]>('/api/cve') })
};

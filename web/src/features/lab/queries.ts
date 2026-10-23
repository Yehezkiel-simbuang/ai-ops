import { queryOptions } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import type { LabDesign, LabProject, LabProjectSummary, LabResult, Scenario } from './types';

export const labQ = {
  projects: () => queryOptions({ queryKey: ['lab', 'projects'], queryFn: () => get<{ projects: LabProjectSummary[]; foldersEnabled: boolean }>('/api/lab/projects'), staleTime: 60_000 }),
  project: (id: string) => queryOptions({ queryKey: ['lab', 'project', id], queryFn: () => get<LabProject>(`/api/lab/projects/${encodeURIComponent(id)}`), staleTime: Infinity, retry: false }),
  designs: (project: string) => queryOptions({ queryKey: ['lab', 'designs', project], queryFn: () => get<LabDesign[]>(`/api/lab/designs?project=${encodeURIComponent(project)}`) }),
  /** Hasil simulasi untuk satu skenario. Kuncinya adalah skenario itu sendiri, jadi skenario yang sama tidak dihitung ulang. */
  simulate: (s: Scenario) => queryOptions({ queryKey: ['lab', 'simulate', s], queryFn: () => post<LabResult>('/api/lab/simulate', s), staleTime: Infinity, gcTime: 5 * 60_000, retry: false })
};

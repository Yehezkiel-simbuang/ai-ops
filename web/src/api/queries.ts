// Definisi query (kunci + fungsi ambil + interval polling) di satu tempat, dan useAction untuk aksi yang mengubah data.
// Kunci berjenjang: invalidate(['servers']) menyegarkan semua query di bawahnya.
import { queryOptions, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { get, qs } from '@/lib/api';
import { toast } from '@/lib/toast';
import type {
  AgentOverview, AppConfig, AppSettings, AuditEntry, Channel, ChecksMeta, Credential, IncidentDetail, Incident, InventoryRow, MaintenanceLogEntry,
  MaintenanceTask, MaintenanceTemplate, MonitorView, NotificationLog, Overview, Run, RunDetail, RunTemplate, Server, ServerProfile, UsageSummary, User
} from './types';

const s = (n: number) => n * 1000;

export const q = {
  me: () => queryOptions({ queryKey: ['me'], queryFn: () => get<{ user: User }>('/api/me').then((r) => r.user), retry: false, staleTime: s(60) }),
  overview: () => queryOptions({ queryKey: ['overview'], queryFn: () => get<Overview>('/api/overview'), refetchInterval: s(5) }),
  servers: () => queryOptions({ queryKey: ['servers'], queryFn: () => get<Server[]>('/api/servers'), refetchInterval: s(15) }),

  monitor: (id: number) => queryOptions({ queryKey: ['servers', id, 'monitor'], queryFn: () => get<MonitorView>(`/api/servers/${id}/monitor`), refetchInterval: s(10) }),
  checksMeta: () => queryOptions({ queryKey: ['checks-meta'], queryFn: () => get<ChecksMeta>('/api/checks/meta'), staleTime: Infinity }),
  agent: (id: number) => queryOptions({ queryKey: ['servers', id, 'agent'], queryFn: () => get<AgentOverview>(`/api/servers/${id}/agent`), refetchInterval: s(5) }),

  incidents: (status: 'open' | 'resolved') => queryOptions({ queryKey: ['incidents', status], queryFn: () => get<Incident[]>(`/api/incidents${qs({ status })}`), refetchInterval: s(6) }),
  incident: (id: number) => queryOptions({ queryKey: ['incidents', 'detail', id], queryFn: () => get<IncidentDetail>(`/api/incidents/${id}`), refetchInterval: s(1.5) }),

  runs: () => queryOptions({ queryKey: ['runs'], queryFn: () => get<Run[]>('/api/runs'), refetchInterval: s(5) }),
  run: (id: string) => queryOptions({ queryKey: ['runs', id], queryFn: () => get<RunDetail>(`/api/runs/${id}`), refetchInterval: s(1.5) }),
  runTemplates: () => queryOptions({ queryKey: ['run-templates'], queryFn: () => get<RunTemplate[]>('/api/templates'), staleTime: Infinity }),

  usage: (days: number) => queryOptions({ queryKey: ['usage', days], queryFn: () => get<UsageSummary>(`/api/usage${qs({ days })}`), refetchInterval: s(8) }),
  config: () => queryOptions({ queryKey: ['config'], queryFn: () => get<AppConfig>('/api/config') }),
  settings: () => queryOptions({ queryKey: ['settings'], queryFn: () => get<AppSettings>('/api/settings') }),
  audit: () => queryOptions({ queryKey: ['audit'], queryFn: () => get<AuditEntry[]>('/api/audit') }),
  channels: () => queryOptions({ queryKey: ['channels'], queryFn: () => get<Channel[]>('/api/channels') }),
  notifications: () => queryOptions({ queryKey: ['notifications'], queryFn: () => get<NotificationLog[]>('/api/notifications') }),

  inventory: (filter: { q: string; env: string }) => queryOptions({ queryKey: ['inventory', filter], queryFn: () => get<InventoryRow[]>(`/api/inventory${qs(filter)}`), refetchInterval: s(15) }),
  vault: (search: string) => queryOptions({ queryKey: ['vault', search], queryFn: () => get<Credential[]>(`/api/vault${qs({ q: search })}`), refetchInterval: s(15) }),
  maintenance: () => queryOptions({ queryKey: ['maintenance'], queryFn: () => get<MaintenanceTask[]>('/api/maintenance'), refetchInterval: s(15) }),
  maintenanceTemplates: () => queryOptions({ queryKey: ['maintenance-templates'], queryFn: () => get<MaintenanceTemplate[]>('/api/maintenance/templates'), staleTime: Infinity }),
  profile: (id: number) => queryOptions({ queryKey: ['servers', id, 'profile'], queryFn: () => get<ServerProfile>(`/api/servers/${id}/profile`) }),
  serverCredentials: (id: number) => queryOptions({ queryKey: ['servers', id, 'credentials'], queryFn: () => get<Credential[]>(`/api/servers/${id}/credentials`) }),
  serverTasks: (id: number) => queryOptions({ queryKey: ['servers', id, 'tasks'], queryFn: () => get<MaintenanceTask[]>(`/api/servers/${id}/maintenance`) }),
  serverTaskLog: (id: number) => queryOptions({ queryKey: ['servers', id, 'task-log'], queryFn: () => get<MaintenanceLogEntry[]>(`/api/servers/${id}/maintenance-log`) })
};

interface ActionOptions<V, R> {
  success?: string | ((result: R, vars: V) => string | null);
  /** Kunci query yang disegarkan setelah berhasil. */
  invalidate?: QueryKey[];
  onSuccess?: (result: R, vars: V) => void;
}

/** Aksi yang mengubah data: toast galat otomatis, toast sukses opsional, lalu segarkan query terkait. */
export function useAction<V = void, R = unknown>(fn: (vars: V) => Promise<R>, opt: ActionOptions<V, R> = {}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      const msg = typeof opt.success === 'function' ? opt.success(result, vars) : opt.success;
      if (msg) toast(msg);
      opt.onSuccess?.(result, vars);
      await Promise.all((opt.invalidate ?? []).map((queryKey) => client.invalidateQueries({ queryKey })));
    },
    onError: (e: Error) => toast(e.message, true)
  });
}

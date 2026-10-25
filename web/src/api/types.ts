// Bentuk data dari backend (disusun dari yang dipakai UI). Waktu selalu epoch milidetik.

export interface User { id: number; username: string; mustChange?: boolean }

/** Tingkat keparahan, dari paling ringan. critical: tindak sekarang | major: tindak hari ini | minor: lihat kalau sempat | info: hanya jejak. */
export type Level = 'info' | 'minor' | 'major' | 'critical';
export type ServerStatus = 'ok' | 'peringatan' | 'tidak terjangkau' | 'belum';
export type ExecVia = 'auto' | 'ssh' | 'agent';
export interface Server {
  id: number; name: string; host: string; port: number; username: string; key_path: string; has_ssh_key: boolean; ssh_pub: string; playground: boolean; use_sudo: boolean; services: string; notes: string;
  exec_via: ExecVia; os_info: string; last_seen: number | null; last_status: ServerStatus; open_alerts: number;
}
export interface ServerInput {
  name: string; host: string; port: number; username: string; key_path: string; ssh_key?: string; use_sudo: boolean; services: string; notes: string;
  exec_via: ExecVia;
}
export interface ConnectionTest { ok: boolean; info?: string; error?: string; hint?: string; ms?: number }

// ---------- ringkasan
export interface PendingCommand { id: number; run_id: string; run_name: string | null; command: string; purpose: string; reason: string }
export interface UsageTotal { input: number; output: number; calls: number; cost: number; costKnown: boolean }
export interface Overview {
  servers: Array<Pick<Server, 'id' | 'name' | 'host' | 'last_seen' | 'open_alerts'> & { status: ServerStatus }>;
  pending: PendingCommand[]; incidents: Incident[]; recsWaiting: number;
  maintenance: { overdue: number; soon: number }; rotationDue: number;
  runs: Run[]; usage: UsageTotal; alerts: Alert[]; setupReady: boolean; monitorReady: boolean;
}

// ---------- monitoring
export interface Alert { id: number; title: string; detail: string; level: Level; ts: number; resolved: boolean; acked: boolean; server_name?: string }
export type CheckStatus = 'ok' | 'minor' | 'warn' | 'crit' | 'unknown';   // warn = Major, crit = Critical
export interface Check {
  id: number; name: string; type: string; pack?: string; std_source?: 'global' | 'bawaan' | 'sendiri'; params?: Record<string, unknown>; enabled: boolean; minor?: number | null; warn: number | null; crit: number | null;
  last_status: CheckStatus | null; last_detail: string | null; last_value: number | null; last_run: number | null;
}
export interface SeriesPoint { ts: number; value: number }
export interface MonitorReport { ts: number; text: string }
export interface MonitorView {
  server: Server; latest: Record<string, { value: number }>; alerts: Alert[]; reports: MonitorReport[]; checks: Check[];
  series: Record<'load5' | 'mem_avail_pct' | 'disk_root_pct' | 'io_psi10' | 'swap_used_mb', SeriesPoint[]>;
}
export interface PackField { k: string; label: string; def?: string }
export interface PackMeta { id: string; label: string; hint?: string; fields: PackField[] }
export interface CheckTypeMeta { id: string; label: string; fields: string[] }
export interface ChecksMeta { packs: PackMeta[]; types: CheckTypeMeta[] }
export type DiscoverResult = Record<string, { opts?: Record<string, string> } | undefined>;
export interface NewCheck { name: string; type: string; params: Record<string, string>; warn: string; crit: string; dir: string; delta: boolean; confirm: number }

// ---------- agen dan insiden
export interface AgentStatus {
  online: boolean; last_seen: number | null; version: string | null; hostname: string | null; exec_enabled: boolean; open_keys: string[] | null;
}
export type ExecPath = 'ssh' | 'agent' | 'none';
export interface FleetAgent { server_id: number; name: string; state: 'hidup' | 'mati' | 'belum_terhubung' | 'belum_dipasang'; last_seen: number | null; version: string; exec_enabled: boolean; open_keys: number }
export interface PatchRow { server_id: number; name: string; os: string; kernel: string; reported: number | null; stale: boolean; updates: number | null; security: number | null; reboot: boolean; reboot_days: number | null; eol_days: number | null; cves: number | null; exploited: number; vuln_unknown: number; level: Level | null; reasons: Array<{ level: Level; text: string }> }
export interface PatchPkg { name: string; source?: string; old: string; new: string; sec: boolean; cves: string[]; ids: string[]; exploited: string[]; unknown: boolean; external: boolean }
export interface PatchDetail { plan: { id: number; status: RecStatus; created: number } | null; name: string; os: string; reported: number | null; ecosystem: string | null; supported: boolean; matched_at: number | null; kev_at: number | null; total: number; packages: PatchPkg[] }
export interface PatchOverview { rows: PatchRow[]; without_agent: number }
export interface AgentOverview { agent: AgentStatus | null; path: ExecPath; binaries: string[] }
export interface AgentGuide { keyId: string; rotated: boolean; script: string; configText: string; note: string; warnings?: string[] }

export type RecStatus = 'proposed' | 'approved' | 'executing' | 'done' | 'failed' | 'rejected' | 'superseded';
export interface Incident {
  id: number; severity?: Level; title: string; detail: string; server_name: string; opened: number; resolved_at?: number | null; status: 'open' | 'resolved';
  event_count: number; rec_status: RecStatus | null; diag?: Array<{ name: string; out: string }>;
}
export type StepClass = 'read' | 'change' | 'blocked';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'blocked' | 'queued';
export interface RecStep {
  id: number; n: number; title: string; command: string; class: StepClass; risk: 'rendah' | 'sedang' | 'tinggi'; rationale: string; rollback: string;
  status: StepStatus; stdout: string; stderr: string; exit_code: number | null; via: string | null;
}
export interface Recommendation {
  id: number; kind?: 'incident' | 'patch'; status: RecStatus; source: 'llm' | 'playbook'; diagnosis: string; summary: string; verify_out: string; resolved_after: boolean; updated: number; steps: RecStep[];
}
/** Rencana patch = rekomendasi tanpa insiden (kind 'patch'); meta berisi paket dan ringkasan dampaknya. */
export interface PatchPlanPkg { name: string; old: string; new: string; sec: boolean; official: boolean; cves: string[]; exploited: string[]; impact: string | null }
export interface PatchPlanMeta { packages: PatchPlanPkg[]; restarts: string[]; reboot: boolean; totals: { packages: number; security: number; cves: number; exploited: number; thirdParty: number } }
export type PatchPlan = Recommendation & { kind: 'patch'; title: string; meta: PatchPlanMeta; server_name: string; server_id: number; path: ExecPath };
export interface IncidentDetail { incident: Incident & { server_name: string }; recommendations: Recommendation[]; path: ExecPath }

// ---------- setup oleh agen
export type RunStatus = 'draft' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'stopped' | 'interrupted';
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface PlanStep { id: number; title: string; detail?: string; note?: string; status: PlanStepStatus }
export interface Run {
  id: string; name: string; status: RunStatus; goal: string; summary: string; server_name: string | null; steps: PlanStep[];
  updated: number; tokens: number; token_budget: number; turns: number; max_turns: number;
}
export interface RunCommand {
  id: number; ts: number; command: string; purpose: string; reason: string; class: StepClass; status: string; exit_code: number | null;
  stdout: string; stderr: string; decided_by: string | null;
}
export interface RunThought { ts: number; thought: string; command: string; done: boolean; summary: string }
export interface RunDetail { run: Run; commands: RunCommand[]; thoughts: RunThought[] }
export interface RunTemplate { id: string; name: string; goal: string; steps: string[] }
export interface NewRun { serverId: number; name: string; goal: string; template: string | null; dir: string; maxTurns: number; tokenBudget: number }

// ---------- model, token, pengaturan
export interface Provider { id?: string; label: string; type: string; baseUrl: string; hasKey: boolean; keyHint: string; keyless: boolean }
export interface ProviderPreset { id: string; label: string; type: string; baseUrl: string; keyless?: boolean }
export interface AppConfig {
  providers: Record<string, Provider>; roles: Record<string, { provider: string; model: string }>; prices: Record<string, { in: number | null; out: number | null }>; presets: ProviderPreset[];
}
export interface ProviderInput { id: string; label: string; type: string; baseUrl: string; apiKey: string; keyless: boolean }
export interface UsageBucket { input: number; output: number; calls: number; cost: number; costKnown: boolean }
export interface UsageSummary {
  days: number; total: UsageBucket; byRole: Record<string, UsageBucket>; byModel: Record<string, UsageBucket>; byDay: Record<string, { input: number; output: number }>;
  recent: Array<{ ts: number; role: string; provider: string; model: string; input: number; output: number; cost: number | null }>;
}
export interface AppSettings { auto_report: boolean; reminder_min: number; notify_runs: boolean; digest_enabled: boolean; digest_hour: number; quiet_on: boolean; quiet_start: number; quiet_end: number }
export interface AuditEntry { id: number; ts: number; actor: string; action: string; detail: string }
export interface RoleTest { text: string; usage: { input: number; output: number }; ms: number }

export type ChannelType = 'telegram' | 'ntfy' | 'webhook' | 'email';
export type NotifyLevel = Level;
export interface Channel { id: number; type: ChannelType; name: string; min_level: NotifyLevel; enabled: boolean }
export interface NotificationLog { id: number; ts: number; channel_name: string; kind: string; title: string; ok: boolean; error: string }
export interface NewChannel { type: ChannelType; name: string; min_level: NotifyLevel; config: Record<string, string> }

// ---------- inventaris
export type Environment = 'prod' | 'staging' | 'dev' | 'lab' | 'other';
export interface InventoryRow {
  id: number; name: string; host: string; port: number; username: string; os_info: string; primary_address: string | null; purpose: string; tags: string[]; owner: string;
  environment: Environment; overdue: number; next_due: number | null; credentials: number; rotation_due: number;
}
export interface Address { label: string; kind?: string; address: string; is_primary: boolean; notes: string }
export interface ServiceDoc { name: string; port: number | null; protocol: string; url: string; notes: string }
export interface Dependency { id: number; name?: string; note: string }
export interface ServerFacts {
  os?: string; cpu_cores?: number; cpu_model?: string; ram_mb?: number; disk_root?: string; kernel?: string; uptime_d?: number | null; updates?: number | null;
  reboot_required?: boolean; ports?: string[]; tools?: string[];
}
export interface ServerProfile {
  server: Server & { purpose: string; environment: Environment; tags: string[]; location: string; owner: string; runbook: string; facts: ServerFacts | null; facts_at: number | null };
  addresses: Address[]; services: ServiceDoc[]; depends: Dependency[]; dependents: Dependency[];
  counts: { credentials: number; tasks: number; overdue: number };
}
export interface ProfileInput {
  purpose: string; owner: string; location: string; tags: string[]; environment: Environment; runbook: string;
  addresses: Address[]; services: ServiceDoc[]; dependsOn: Array<{ id: number; note: string }>;
}
export interface FactsResult { suggestions: { addresses: unknown[] } }

export type CredentialKind = 'ssh' | 'password' | 'database' | 'web' | 'api_key' | 'ssh_key' | 'other';
export interface Credential {
  id: number; server_id: number | null; server_name?: string; label: string; kind: CredentialKind; username: string; url: string; port: number | null; notes: string;
  has_secret: boolean; versions: number; age_days: number; rotated_at: number; last_revealed: number | null;
  rotate_every_days: number | null; rotation_due_at: number | null; rotation_overdue: boolean; expires_at: number | null; expired: boolean;
}
export interface CredentialInput {
  label: string; kind: CredentialKind; username: string; url: string; port: number | null; notes: string; rotate_every_days: number | null; expires_at: number | null;
  secret?: string; generate?: { length: number; symbols: boolean; avoidAmbiguous: boolean };
}
export interface CredentialSaved { generated?: string }
export interface Revealed { secret: string; username?: string; changed_at?: number }
export interface CredentialVersion { id: number; changed_at: number; changed_by: string | null }
export interface GeneratedSecret { password: string; username: string }

export interface MaintenanceTask {
  id: number; server_id: number; server_name?: string; title: string; description: string; category: string; priority: 'rendah' | 'normal' | 'tinggi'; every_days: number | null;
  due_at: number; last_done: number | null; status: 'terlambat' | 'segera' | 'ok' | 'nonaktif';
}
export interface MaintenanceTemplate { id: string; title: string; every_days: number }
export interface MaintenanceLogEntry { id: number; title: string; done_at: number; done_by: string | null; notes: string }
export interface NewTask { title: string; description: string; every_days: number | null; due_at?: number; priority: string }

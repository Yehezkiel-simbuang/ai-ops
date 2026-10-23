// Pemetaan status -> label/warna, satu tempat agar konsisten di semua halaman.
import type { Environment, Level, RecStatus, RunStatus, ServerStatus } from '@/api/types';
import { LABEL, TONE, isLevel } from '@/lib/levels';
import { Badge, type Tone } from './ui/Badge';
import { IconOk, IconAlert, IconBad, IconTimer, type IconType } from './icons';

const SERVER: Record<ServerStatus, [Tone, IconType, string]> = {
  ok: ['ok', IconOk, 'Sehat'], peringatan: ['warn', IconAlert, 'Peringatan'], 'tidak terjangkau': ['bad', IconBad, 'Tidak terjangkau'], belum: ['mute', IconTimer, 'Belum diperiksa']
};
export function ServerStatusBadge({ status }: { status: ServerStatus }) {
  const [tone, icon, label] = SERVER[status] ?? SERVER.belum;
  return <Badge tone={tone} icon={icon}>{label}</Badge>;
}

const RUN: Record<RunStatus, [Tone, string]> = {
  draft: ['mute', 'Draf'], running: ['acc', 'Berjalan'], waiting_approval: ['warn', 'Menunggu persetujuan'], done: ['ok', 'Selesai'], failed: ['bad', 'Gagal'], stopped: ['mute', 'Dihentikan'], interrupted: ['warn', 'Terputus']
};
export function RunStatusBadge({ status }: { status: RunStatus }) {
  const [tone, label] = RUN[status] ?? RUN.draft;
  return <Badge tone={tone}>{label}</Badge>;
}

const REC: Record<RecStatus, [Tone, string]> = {
  proposed: ['warn', 'Rekomendasi siap'], approved: ['acc', 'Disetujui'], executing: ['acc', 'Dijalankan'], done: ['ok', 'Perbaikan selesai'],
  failed: ['bad', 'Perbaikan gagal'], rejected: ['mute', 'Ditolak'], superseded: ['mute', 'Digantikan']
};
export function RecStatusBadge({ status }: { status: RecStatus | null }) {
  const [tone, label] = (status && REC[status]) || ['mute', 'Menyusun rekomendasi'];
  return <Badge tone={tone}>{label}</Badge>;
}

const ENV: Record<Environment, [Tone, string]> = { prod: ['bad', 'prod'], staging: ['warn', 'staging'], dev: ['acc', 'dev'], lab: ['mute', 'lab'], other: ['mute', 'lain'] };
export function EnvBadge({ env }: { env: Environment }) {
  const [tone, label] = ENV[env] ?? ENV.other;
  return <Badge tone={tone}>{label}</Badge>;
}

/** Insiden terbuka ditandai dengan tingkatnya; insiden selesai dengan "pulih". */
export const IncidentBadge = ({ status, severity }: { status: 'open' | 'resolved'; severity?: Level }) => (status === 'open' ? <LevelBadge level={severity ?? 'critical'} /> : <Badge tone="ok">pulih</Badge>);
export const LevelBadge = ({ level }: { level: string }) => (isLevel(level) ? <Badge tone={TONE[level]}>{LABEL[level]}</Badge> : <Badge tone="mute">{level}</Badge>);

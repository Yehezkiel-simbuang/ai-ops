// Tingkat keparahan: satu tempat untuk urutan, label, dan warna. Label memakai istilah Inggris (Info, Minor, Major, Critical).
import type { Level } from '@/api/types';
import type { Tone } from '@/components/ui/Badge';

/** Dari paling parah ke paling ringan. */
export const LEVELS: Level[] = ['critical', 'major', 'minor', 'info'];
export const RANK: Record<Level, number> = { info: 1, minor: 2, major: 3, critical: 4 };
export const LABEL: Record<Level, string> = { critical: 'Critical', major: 'Major', minor: 'Minor', info: 'Info' };
export const TONE: Record<Level, Tone> = { critical: 'bad', major: 'warn', minor: 'acc', info: 'info' };
/** Arti tiap tingkat: apa yang Anda lakukan. */
export const MEANING: Record<Level, string> = { critical: 'tindak sekarang', major: 'tindak hari ini', minor: 'lihat kalau sempat', info: 'hanya jejak, tanpa tindakan' };

export const isLevel = (x: unknown): x is Level => typeof x === 'string' && x in RANK;
export const rank = (x: unknown): number => (isLevel(x) ? RANK[x] : 0);
/** Urutan: paling parah dulu. */
export const bySeverity = (a: { level: string }, b: { level: string }): number => rank(b.level) - rank(a.level);
/** Status pemeriksaan (warn = Major, crit = Critical) menjadi tingkat. */
export const levelOfStatus = (s: string | null | undefined): Level | null => (s === 'crit' ? 'critical' : s === 'warn' ? 'major' : s === 'minor' || s === 'unknown' ? 'minor' : null);

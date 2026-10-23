// Tingkat keparahan, satu-satunya sumber kebenaran. Urutan menentukan kapan sebuah kejadian dikabarkan:
//   critical : tindak sekarang    major : tindak hari ini    minor : lihat kalau sempat    info : hanya jejak, tanpa tindakan
// Kanal menerima SEGERA mulai dari min_level-nya (bawaan major). Minor masuk ringkasan harian; info hanya tercatat.
export const LEVELS = ['info', 'minor', 'major', 'critical'] as const;
export type Level = (typeof LEVELS)[number];
export const RANK: Record<Level, number> = { info: 1, minor: 2, major: 3, critical: 4 };
export const LABEL: Record<Level, string> = { info: 'Info', minor: 'Minor', major: 'Major', critical: 'Critical' };

export const isLevel = (x: unknown): x is Level => typeof x === 'string' && (LEVELS as readonly string[]).includes(x);
export const rank = (x: unknown): number => (isLevel(x) ? RANK[x] : 0);
/** Tingkat yang lebih parah dari dua. */
export const worse = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

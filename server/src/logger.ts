// Logger terstruktur (pino). Header sensitif tidak pernah ikut tercatat.
import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger };

/** dest hanya untuk uji (menangkap keluaran log). */
export function createLogger(level: string, dest?: DestinationStream): Logger {
  return pino({ level, redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-aiops-sig"]', 'res.headers["set-cookie"]'], censor: '[disembunyikan]' } }, dest);
}

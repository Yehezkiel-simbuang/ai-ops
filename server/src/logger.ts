// Logger terstruktur (pino). Header sensitif tidak pernah ikut tercatat.
import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({ level, redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '[disembunyikan]' } });
}

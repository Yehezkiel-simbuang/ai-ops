// Penanganan galat dan 404 yang seragam: selalu JSON { error } untuk API.
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../../context.js';

export const notFound: RequestHandler = (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/agent/')) res.status(404).json({ error: 'Tidak ada' });
  else res.status(404).type('text/plain').send('Tidak ada');
};

const BODY_ERRORS: Record<string, [number, string]> = { 'entity.parse.failed': [400, 'JSON tidak valid'], 'entity.too.large': [413, 'Badan permintaan terlalu besar'] };

export const errorHandler: ErrorRequestHandler = (err: Error & { status?: number; statusCode?: number; type?: string }, req, res, _next) => {
  if (res.headersSent) { res.end(); return; }
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
  if (err instanceof ZodError) { res.status(400).json({ error: err.issues.map((i) => i.message).join('; ') }); return; }
  const body = err.type ? BODY_ERRORS[err.type] : undefined;
  if (body) { res.status(body[0]).json({ error: body[1] }); return; }
  const status = err.status ?? err.statusCode;
  if (status && status < 500) { res.status(status).json({ error: err.message }); return; }
  req.log.error({ err }, 'kesalahan tidak tertangani');
  res.status(500).json({ error: 'Kesalahan internal', requestId: req.id });
};

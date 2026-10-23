// Pembantu rute: handler cukup mengembalikan data (dikirim sebagai JSON); validasi badan/parameter dengan zod.
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { bad } from '../context.js';

/** Bungkus handler async. Nilai kembalian dikirim sebagai JSON kecuali handler sudah menjawab sendiri.
 *  Galat yang dilempar diteruskan Express 5 ke errorHandler. */
export function handle(fn: (req: Request, res: Response) => unknown | Promise<unknown>): RequestHandler {
  return async (req, res) => {
    const out = await fn(req, res);
    if (!res.headersSent && out !== undefined) res.json(out);
  };
}

/** Validasi data dengan skema zod; kegagalan menjadi 400 dengan pesan per field. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw bad(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export const positiveInt = z.coerce.number().int().positive();

/** Parameter jalur bertipe id (bilangan bulat positif), mis. /servers/:id. */
export const idParam = (req: Request, key = 'id'): number => parse(positiveInt, req.params[key]);

/** Parameter jalur berupa teks bebas (mis. id run). */
export const strParam = (req: Request, key = 'id'): string => String(req.params[key]);

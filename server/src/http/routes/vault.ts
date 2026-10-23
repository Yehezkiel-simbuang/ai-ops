// Vault kredensial: simpan terenkripsi, ungkap (butuh password akun), rotasi, riwayat versi, pembuat password.
import { Router } from 'express';
import { z } from 'zod';
import * as Vault from '../../vault.js';
import { handle, idParam, parse } from '../handle.js';
import { sensitiveLimiter } from '../middleware/rateLimit.js';

const generatorOptions = z.object({ length: z.number().optional(), upper: z.boolean().optional(), lower: z.boolean().optional(), digits: z.boolean().optional(), symbols: z.boolean().optional(), avoidAmbiguous: z.boolean().optional() });
const credentialBody = z.object({
  label: z.string().optional(), kind: z.string().optional(), username: z.string().optional(), secret: z.string().optional(), generate: z.union([z.boolean(), generatorOptions]).optional(),
  url: z.string().optional(), port: z.union([z.number(), z.string(), z.null()]).optional(), notes: z.string().optional(), rotate_every_days: z.union([z.number(), z.string(), z.null()]).optional(), expires_at: z.number().nullish()
});
const revealBody = z.object({ password: z.string().min(1).max(500) });
const generateBody = generatorOptions.extend({ username_prefix: z.string().max(30).optional() });

export function vaultRoutes(): Router {
  const r = Router(), strict = sensitiveLimiter();
  r.get('/vault', handle((req) => Vault.list(null, req.query.q as string | undefined)));
  r.post('/vault', handle((req) => Vault.create(null, parse(credentialBody, req.body) as never, req.user!.username)));
  r.post('/vault/generate', handle((req) => { const b = parse(generateBody, req.body); return { password: Vault.generatePassword(b), username: Vault.generateUsername(b.username_prefix) }; }));
  r.get('/servers/:id/credentials', handle((req) => Vault.list(idParam(req))));
  r.post('/servers/:id/credentials', handle((req) => Vault.create(idParam(req), parse(credentialBody, req.body) as never, req.user!.username)));
  r.put('/credentials/:id', handle((req) => Vault.update(idParam(req), parse(credentialBody, req.body) as never, req.user!.username)));
  r.delete('/credentials/:id', handle(async (req) => { await Vault.remove(idParam(req), req.user!.username); return { ok: true }; }));
  r.post('/credentials/:id/reveal', strict, handle((req) => Vault.reveal(idParam(req), parse(revealBody, req.body).password, req.user!.id, req.user!.username)));
  r.post('/credentials/:id/rotate', strict, handle((req) => Vault.rotate(idParam(req), parse(generatorOptions, req.body), req.user!.username)));
  r.get('/credentials/:id/versions', handle((req) => Vault.versions(idParam(req))));
  r.post('/credential-versions/:id/reveal', strict, handle((req) => Vault.revealVersion(idParam(req), parse(revealBody, req.body).password, req.user!.id, req.user!.username)));
  return r;
}

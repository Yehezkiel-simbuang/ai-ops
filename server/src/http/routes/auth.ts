// Masuk, keluar, profil sesi, ganti password.
import { Router } from 'express';
import { z } from 'zod';
import * as Auth from '../../auth.js';
import type { Config } from '../../config.js';
import { handle, parse } from '../handle.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from '../middleware/session.js';

const loginBody = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) });
const passwordBody = z.object({ current: z.string().min(1), next: z.string().min(12).max(500) });

/** Satu-satunya rute API yang bisa diakses tanpa sesi. */
export function loginRoutes(cfg: Config): Router {
  const r = Router();
  r.post('/login', loginLimiter(), handle(async (req, res) => {
    const b = parse(loginBody, req.body);
    const session = await Auth.login(cfg, b.username, b.password, req.ip ?? '', String(req.headers['user-agent'] ?? ''));
    if (!session) { await new Promise((done) => setTimeout(done, 400)); res.status(401).json({ error: 'Pengguna atau password salah' }); return; }
    setSessionCookie(cfg, res, session.token);
    return { ok: true, user: session.user };
  }));
  return r;
}

export function accountRoutes(): Router {
  const r = Router();
  r.post('/logout', handle(async (req, res) => { await Auth.logout(req.cookies[SESSION_COOKIE]); clearSessionCookie(res); return { ok: true }; }));
  r.get('/me', handle((req) => ({ user: req.user })));
  r.post('/account/password', handle(async (req, res) => {
    const b = parse(passwordBody, req.body);
    await Auth.changePassword(req.user!.id, b.current, b.next);
    clearSessionCookie(res);   // semua sesi lama sudah dicabut
    return { ok: true };
  }));
  return r;
}

// Sesi berbasis cookie: baca, wajibkan (JSON 401 untuk API, redirect untuk halaman), set/hapus cookie.
import type { CookieOptions, RequestHandler, Response } from 'express';
import * as Auth from '../../auth.js';
import type { Config } from '../../config.js';

export const SESSION_COOKIE = 'aiops_sid';

const cookieOptions = (cfg: Config): CookieOptions => ({ httpOnly: true, sameSite: 'strict', secure: cfg.cookieSecure, path: '/' });

export const setSessionCookie = (cfg: Config, res: Response, token: string): void => { res.cookie(SESSION_COOKIE, token, { ...cookieOptions(cfg), maxAge: cfg.SESSION_TTL_HOURS * 3600 * 1000 }); };
export const clearSessionCookie = (res: Response): void => { res.clearCookie(SESSION_COOKIE, { path: '/' }); };

function loadUser(cfg: Config): RequestHandler {
  return async (req, _res, next) => { req.user = (await Auth.authenticate(cfg, req.cookies?.[SESSION_COOKIE])) ?? undefined; next(); };
}

/** Wajib login untuk API: tanpa sesi -> 401 JSON. */
export function requireApiSession(cfg: Config): RequestHandler[] {
  return [loadUser(cfg), (req, res, next) => {
    if (!req.user) { res.status(401).json({ error: 'Belum masuk' }); return; }
    // password bawaan: tidak ada yang boleh dipakai selain melihat profil, keluar, dan mengganti password
    if (req.user.mustChange && !MUST_CHANGE_ALLOWED.has(req.path)) { res.status(403).json({ error: 'Anda wajib mengganti password sebelum memakai aplikasi', code: 'password_change_required' }); return; }
    next();
  }];
}
const MUST_CHANGE_ALLOWED = new Set(['/me', '/logout', '/account/password']);

/** Wajib login untuk halaman server-side (mis. /lab): tanpa sesi -> alihkan ke /login. */
export function requirePageSession(cfg: Config): RequestHandler[] {
  return [loadUser(cfg), (req, res, next) => { if (req.user) return next(); res.redirect('/login'); }];
}

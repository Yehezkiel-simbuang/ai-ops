// Antarmuka untuk runner pembangkit beban (/loadgen/v1/*). Runner yang menghubungi aplikasi (keluar saja), memakai bearer rahasia bersama.
// Runner hanya mengambil uji yang SUDAH Anda setujui (status queued); ia tidak bisa membuat atau memulai uji sendiri.
import express, { Router, type RequestHandler } from 'express';
import type { Config } from '../config.js';
import { metaSet } from '../context.js';
import { safeEqual } from '../crypto.js';
import * as Store from '../loadtest/store.js';
import { finishSchema, runnerInfoSchema, stageReportSchema } from '../loadtest/schema.js';
import { handle, idParam, parse } from './handle.js';
import { limiter } from './middleware/rateLimit.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadgenApi(cfg: Config): Router {
  const r = Router();
  let lastSeenWrite = 0;
  const auth: RequestHandler = (req, res, next) => {
    if (!cfg.LOADGEN_SECRET) { res.status(404).json({ error: 'Pembangkit beban belum diaktifkan (LOADGEN_SECRET belum disetel)' }); return; }
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(token, cfg.LOADGEN_SECRET)) { res.status(401).json({ error: 'tidak sah' }); return; }
    const now = Date.now();
    if (now - lastSeenWrite > 5000) { lastSeenWrite = now; void metaSet('loadgen_seen', String(now)).catch(() => undefined); }   // runner yang sedang menjalankan uji juga tetap terlihat online
    next();
  };
  r.use(limiter({ max: 600 }), auth, express.json({ limit: '256kb' }));

  /** Ambil uji berikutnya yang sudah disetujui. Long-poll maksimal 25 detik; balasan { job: null } bila tidak ada. */
  r.post('/next', handle(async (req, res) => {
    const info = parse(runnerInfoSchema, req.body), wait = Math.min(25, Math.max(0, Number(req.query.wait) || 0));
    await metaSet('loadgen_seen', String(Date.now())); await metaSet('loadgen_info', JSON.stringify(info));   // untuk indikator "runner online" di UI
    let closed = false; res.on('close', () => { closed = true; });
    for (let i = 0; ; i++) {
      const job = await Store.claim(info);
      if (job) return { job };
      if (i >= wait || closed) return { job: null };
      await sleep(1000);
    }
  }));
  r.post('/jobs/:id/stage', handle((req) => Store.addStage(idParam(req), parse(stageReportSchema, req.body))));
  r.post('/jobs/:id/heartbeat', handle((req) => Store.heartbeat(idParam(req))));
  r.post('/jobs/:id/finish', handle(async (req) => { const b = parse(finishSchema, req.body); await Store.finish(idParam(req), b.status, b.error); return { ok: true }; }));
  return r;
}

// Skema masukan uji beban (zod). Batasnya sengaja ketat: uji beban adalah aksi yang bisa merusak, jadi apa yang boleh dikirim dibatasi sejak masukan.
import { z } from 'zod';

const headerName = z.string().regex(/^[A-Za-z0-9-]{1,40}$/);

export const requestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  path: z.string().max(300).regex(/^\/[^\s]*$/, 'Path harus diawali / dan tanpa spasi'),
  weight: z.number().int().min(1).max(100),
  body: z.string().max(4000).optional()
});
export type LoadRequest = z.infer<typeof requestSchema>;

export const stageSchema = z.object({ vus: z.number().int().min(1).max(2000), seconds: z.number().int().min(5).max(600) });
export type LoadStage = z.infer<typeof stageSchema>;

/** Metrik server uji yang dibaca selama tahap: `metric` = nama metrik Prometheus (mis. node_load1) atau jalur kunci JSON (mis. pool.inUse). */
export const scrapeSchema = z.object({ label: z.string().trim().min(1).max(40), url: z.string().url().max(300), metric: z.string().trim().min(1).max(100) });

export const criteriaSchema = z.object({ p95Ms: z.number().min(10).max(60_000), errPct: z.number().min(0).max(100) });
export type Criteria = z.infer<typeof criteriaSchema>;

export const MAX_TOTAL_SECONDS = 3600;

export const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  target: z.string().url().max(200),
  /** Pernyataan eksplisit bahwa target bukan produksi; wajib true. */
  confirmNotProduction: z.literal(true, { error: 'Konfirmasi bahwa target BUKAN produksi wajib dicentang' }),
  requests: z.array(requestSchema).min(1).max(20),
  thinkSeconds: z.number().min(0).max(30).default(1),
  /** Header yang dikirim ke target (mis. Authorization untuk staging). Dienkripsi; tidak pernah ditampilkan kembali. */
  headers: z.record(headerName, z.string().max(400)).default({}).refine((h) => Object.keys(h).length <= 10 && !Object.keys(h).some((k) => k.toLowerCase() === 'host'), 'Maks. 10 header, dan Host tidak boleh diubah'),
  stages: z.array(stageSchema).min(1).max(12),
  criteria: criteriaSchema.default({ p95Ms: 1000, errPct: 1 }),
  scrape: z.array(scrapeSchema).max(6).default([]),
  playgroundId: z.number().int().positive().optional()   // susunan playground yang diuji; ringkasannya disimpan untuk perbandingan
}).refine((v) => v.stages.reduce((s, x) => s + x.seconds, 0) <= MAX_TOTAL_SECONDS, { message: `Total durasi tahap maksimal ${MAX_TOTAL_SECONDS} detik`, path: ['stages'] });
export type CreateInput = z.infer<typeof createSchema>;

/** Laporan satu tahap dari runner. */
export const stageReportSchema = z.object({
  idx: z.number().int().min(0).max(11), vus: z.number().int().min(1).max(2000), seconds: z.number().int().min(1).max(600),
  started: z.number(), ended: z.number(), reqs: z.number().min(0), rps: z.number().min(0), p50: z.number().min(0), p95: z.number().min(0), p99: z.number().min(0),
  errPct: z.number().min(0).max(100), genCpu: z.number().min(0).max(1),
  scraped: z.record(z.string().max(40), z.object({ avg: z.number(), max: z.number(), last: z.number() })).default({})
});
export type StageReport = z.infer<typeof stageReportSchema>;

export const finishSchema = z.object({ status: z.enum(['done', 'failed', 'cancelled']), error: z.string().max(500).default('') });
export const runnerInfoSchema = z.object({ k6: z.string().max(60).default(''), cpus: z.number().min(0).max(1024).default(0), version: z.string().max(40).default('') });

/** Pemakaian CPU pembangkit di atas ini membuat hasil tahap tidak murni (yang jenuh mungkin pembangkitnya). */
export const MAX_GEN_CPU = 0.7;

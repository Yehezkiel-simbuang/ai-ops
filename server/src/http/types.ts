// Menambah properti yang diisi middleware ke tipe Request Express.
import type { AgentRow } from '../agents.js';
import type { SessionUser } from '../auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;                              // diisi middleware sesi
      agent?: AgentRow & { secret: string };           // diisi verifikasi HMAC agen
      rawBody?: Buffer;                                // badan mentah API agen (untuk tanda tangan)
    }
  }
}
export {};

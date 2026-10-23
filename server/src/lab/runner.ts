// Menjalankan pekerjaan CPU lab (analisis proyek, simulasi) di worker thread: server HTTP dan agen tidak tertahan.
// Pekerjaan diproses satu per satu; yang melewati batas waktu menghentikan worker (dibuat ulang untuk pekerjaan berikutnya).
import { Worker } from 'node:worker_threads';

interface Reply { id: number; ok: boolean; result?: unknown; error?: string }

export class LabRunner {
  private worker: Worker | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private readonly script: string, private readonly timeoutMs = 30_000) {}

  /** Antre satu pekerjaan; hasilnya dari worker, atau galat bila gagal/melewati batas waktu. */
  call<T>(op: string, payload: unknown = {}): Promise<T> {
    const job = this.tail.then(() => this.run<T>(op, payload));
    this.tail = job.catch(() => undefined);
    return job;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.script);
    w.on('exit', () => { if (this.worker === w) this.worker = null; });
    w.on('error', () => { if (this.worker === w) this.worker = null; });
    this.worker = w;
    return w;
  }

  private run<T>(op: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const worker = this.start(), id = ++this.seq;
      const done = () => { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); };
      const onMessage = (m: Reply) => {
        if (m.id !== id) return;
        done();
        if (m.ok) resolve(m.result as T); else reject(new Error(m.error ?? 'Pekerjaan lab gagal'));
      };
      const onError = (e: Error) => { done(); reject(new Error(`Worker lab berhenti: ${e.message}`)); };
      const onExit = () => { done(); reject(new Error('Worker lab berhenti tiba-tiba')); };
      const timer = setTimeout(() => { done(); void worker.terminate(); reject(new Error('Simulasi melewati batas waktu. Kurangi beban atau durasinya.')); }, this.timeoutMs);
      worker.on('message', onMessage); worker.on('error', onError); worker.on('exit', onExit);
      worker.postMessage({ id, op, payload });
    });
  }

  async close(): Promise<void> {
    const w = this.worker; this.worker = null;
    if (w) await w.terminate();
  }
}

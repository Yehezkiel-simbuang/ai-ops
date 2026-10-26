import type { ReactNode } from 'react';

/** Satu langkah bernomor pada halaman penyusun (Playground, Uji beban baru): judul, penjelasan singkat, lalu isinya. */
export function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="pg-step">
      <div className="pg-num" aria-hidden>{n}</div>
      <div className="pg-body">
        <h2>{title}</h2>
        {hint && <p className="lbl" style={{ marginTop: 0 }}>{hint}</p>}
        {children}
      </div>
    </section>
  );
}

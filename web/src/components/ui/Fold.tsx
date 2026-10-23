// Bagian yang dilipat: judul dengan ringkasan satu baris tetap terlihat, isinya dibuka bila perlu.
import type { ReactNode } from 'react';

export function Fold({ title, hint, open = false, children }: { title: ReactNode; hint?: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details className="group fold" open={open}>
      <summary><b>{title}</b>{hint && <span className="lbl">{hint}</span>}</summary>
      <div className="body">{children}</div>
    </details>
  );
}

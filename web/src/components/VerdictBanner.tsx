// Vonis satu kata di bagian paling atas halaman (Ringkasan dan Monitor): warna dan ikon menyatakan seberapa mendesak, penjelasan di bawahnya.
import type { ReactNode } from 'react';
import { IconAlert, IconBad, IconOk, IconTimer, type IconType } from '@/components/icons';

export type Verdict = 'down' | 'crit' | 'warn' | 'ok' | 'nodata';
const ICON: Record<Verdict, IconType> = { ok: IconOk, warn: IconAlert, crit: IconBad, down: IconBad, nodata: IconTimer };

export function VerdictBanner({ verdict, headline, detail, facts, aside, label }: { verdict: Verdict; headline: string; detail: string; facts?: ReactNode; aside?: ReactNode; label: string }) {
  const Icon = ICON[verdict];
  return (
    <section className={`verdict ${verdict}`} aria-label={label}>
      <Icon size={28} aria-hidden />
      <div className="grow">
        <h2>{headline}</h2>
        <p>{detail}</p>
        {facts && <p className="lbl">{facts}</p>}
      </div>
      {aside}
    </section>
  );
}

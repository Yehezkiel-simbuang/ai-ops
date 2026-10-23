// Panduan pemakaian di dalam aplikasi: dari menyiapkan server sampai memakai tiap fitur. Isinya di content.tsx.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHead, Section } from '@/components/ui/Layout';
import { IconBook } from '@/components/icons';
import { SECTIONS } from './content';

export function GuidePage() {
  const [params] = useSearchParams(), target = params.get('bagian');   // tautan dari halaman lain: /panduan?bagian=kunci
  const [active, setActive] = useState(SECTIONS.some((s) => s.id === target) ? target! : SECTIONS[0]!.id);
  const go = (id: string) => { setActive(id); document.getElementById(`panduan-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  useEffect(() => { if (target && SECTIONS.some((s) => s.id === target)) document.getElementById(`panduan-${target}`)?.scrollIntoView?.({ block: 'start' }); }, [target]);
  return (
    <>
      <PageHead title="Panduan" icon={IconBook} />
      <div className="cols wide-left">
        <div className="guide">
          {SECTIONS.map((s, i) => (
            <div key={s.id} id={`panduan-${s.id}`}>
              <Section title={`${i + 1}. ${s.title}`} icon={IconBook}>{s.body}</Section>
            </div>
          ))}
        </div>
        <nav aria-label="Daftar isi panduan" className="panel guide-toc">
          <h2>Daftar isi</h2>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {SECTIONS.map((s) => <li key={s.id}><button type="button" className="linklike" aria-current={active === s.id ? 'true' : undefined} onClick={() => go(s.id)}>{s.title}</button></li>)}
          </ol>
        </nav>
      </div>
    </>
  );
}

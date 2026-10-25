import { Button } from '@/components/ui/Button';
import { IconCopy } from '@/components/icons';
import { copyText } from '@/lib/clipboard';
import { toast } from '@/lib/toast';

/** Blok perintah yang bisa disalin. Teks tampil apa adanya agar bisa diperiksa sebelum dijalankan. */
export function CodeBlock({ title, children }: { title?: string; children: string }) {
  const copy = async () => { if (await copyText(children)) toast('Tersalin'); else toast('Gagal menyalin; pilih teks lalu salin manual', true); };
  return (
    <div className="codeblock">
      {title && <div className="lbl" style={{ marginBottom: 4 }}>{title}</div>}
      <pre className="mono" tabIndex={0} style={{ margin: 0, padding: 10, overflowX: 'auto', fontSize: '.78rem', border: '1px solid var(--line)', borderRadius: 6 }}>{children}</pre>
      <div className="row" style={{ marginTop: 6 }}><Button icon={IconCopy} aria-label={`Salin${title ? `: ${title}` : ''}`} onClick={copy}>Salin</Button></div>
    </div>
  );
}

// Dialog imperatif berbasis janji: pengganti confirm()/prompt() bawaan peramban, plus konfirmasi password dan penampil rahasia.
//   const { confirm, askPassword } = useDialogs();   if (await confirm('Hapus server ini?')) { ... }
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from '@/lib/toast';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { IconCheck, IconClose, IconCopy, IconKey, IconLock } from '../icons';

const SECRET_VISIBLE_MS = 30_000;

type Active =
  | { kind: 'confirm'; message: ReactNode; confirmLabel: string; resolve: (ok: boolean) => void }
  | { kind: 'password'; message: string; resolve: (pw: string | null) => void }
  | { kind: 'prompt'; message: string; label: string; resolve: (text: string | null) => void }
  | { kind: 'secret'; title: string; sub?: string; secret: string; persistent?: boolean };

export interface Dialogs {
  confirm: (message: ReactNode, confirmLabel?: string) => Promise<boolean>;
  askPassword: (message: string) => Promise<string | null>;
  promptText: (message: string, label: string) => Promise<string | null>;
  /** Tampilkan rahasia sekali; otomatis tertutup dalam 30 detik. */
  showSecret: (title: string, sub: string | undefined, secret: string) => void;
  /** Tampilkan teks yang bukan rahasia (mis. kunci publik): tidak menutup sendiri dan papan klip tidak dikosongkan. */
  showText: (title: string, sub: string | undefined, text: string) => void;
}

const Ctx = createContext<Dialogs | null>(null);
export function useDialogs(): Dialogs {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDialogs harus di dalam DialogProvider');
  return v;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Active | null>(null);
  const activeRef = useRef<Active | null>(null);
  activeRef.current = active;

  const dismiss = useCallback(() => {
    const a = activeRef.current;
    if (a?.kind === 'confirm') a.resolve(false);
    if (a?.kind === 'password' || a?.kind === 'prompt') a.resolve(null);
    setActive(null);
  }, []);

  const api = useMemo<Dialogs>(() => ({
    confirm: (message, confirmLabel = 'Lanjutkan') => new Promise((resolve) => setActive({ kind: 'confirm', message, confirmLabel, resolve })),
    askPassword: (message) => new Promise((resolve) => setActive({ kind: 'password', message, resolve })),
    promptText: (message, label) => new Promise((resolve) => setActive({ kind: 'prompt', message, label, resolve })),
    showSecret: (title, sub, secret) => setActive({ kind: 'secret', title, sub, secret }),
    showText: (title, sub, text) => setActive({ kind: 'secret', title, sub, secret: text, persistent: true })
  }), []);

  return (
    <Ctx.Provider value={api}>
      {children}
      <Modal open={active !== null} onClose={dismiss}>
        {active?.kind === 'confirm' && <ConfirmBody a={active} close={() => setActive(null)} />}
        {active?.kind === 'password' && <TextBody a={active} secret title="Konfirmasi password" label="Password akun Anda" confirmLabel="Konfirmasi" icon="lock" close={() => setActive(null)} />}
        {active?.kind === 'prompt' && <TextBody a={active} title="Catatan" label={active.label} confirmLabel="Simpan" icon="check" close={() => setActive(null)} />}
        {active?.kind === 'secret' && <SecretBody a={active} close={() => setActive(null)} />}
      </Modal>
    </Ctx.Provider>
  );
}

function ConfirmBody({ a, close }: { a: Extract<Active, { kind: 'confirm' }>; close: () => void }) {
  const done = (ok: boolean) => { a.resolve(ok); close(); };
  return (
    <div className="form">
      <h2><IconCheck size={16} aria-hidden />Konfirmasi</h2>
      <div className="note" style={{ whiteSpace: 'pre-line' }}>{a.message}</div>
      <div className="row"><Button primary icon={IconCheck} onClick={() => done(true)}>{a.confirmLabel}</Button><Button icon={IconClose} onClick={() => done(false)}>Batal</Button></div>
    </div>
  );
}

function TextBody({ a, secret, title, label, confirmLabel, icon, close }: {
  a: Extract<Active, { kind: 'password' | 'prompt' }>; secret?: boolean; title: string; label: string; confirmLabel: string; icon: 'lock' | 'check'; close: () => void;
}) {
  const [value, setValue] = useState('');
  const done = (v: string | null) => { a.resolve(v); close(); };
  const submit = (e: FormEvent) => { e.preventDefault(); done(value); };
  return (
    <form className="form" onSubmit={submit}>
      <h2>{icon === 'lock' ? <IconLock size={16} aria-hidden /> : <IconCheck size={16} aria-hidden />}{title}</h2>
      <p className="note">{a.message}</p>
      <Field label={label}>
        <input autoFocus type={secret ? 'password' : 'text'} autoComplete={secret ? 'current-password' : 'off'} value={value} onChange={(e) => setValue(e.target.value)} aria-label={label} />
      </Field>
      <div className="row"><button type="submit" className="primary"><IconCheck size={16} aria-hidden />{confirmLabel}</button><Button icon={IconClose} onClick={() => done(null)}>Batal</Button></div>
    </form>
  );
}

function SecretBody({ a, close }: { a: Extract<Active, { kind: 'secret' }>; close: () => void }) {
  useEffect(() => { if (a.persistent) return undefined; const t = setTimeout(close, SECRET_VISIBLE_MS); return () => clearTimeout(t); }, [close, a.persistent]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(a.secret);
      if (a.persistent) { toast('Tersalin'); return; }
      toast('Tersalin. Papan klip dikosongkan setelah 30 detik.');
      setTimeout(() => { navigator.clipboard.writeText('').catch(() => undefined); }, SECRET_VISIBLE_MS);
    } catch { toast('Gagal menyalin; pilih teks lalu salin manual', true); }
  };
  return (
    <div className="form">
      <h2><IconKey size={16} aria-hidden />{a.title}</h2>
      {a.sub && <p className="note">{a.sub}</p>}
      <pre className="out" style={{ fontSize: '.95rem', wordBreak: 'break-all' }}>{a.secret}</pre>
      {!a.persistent && <span className="lbl">Disembunyikan otomatis dalam 30 detik</span>}
      <div className="row"><Button primary icon={IconCopy} onClick={copy}>Salin</Button><Button icon={IconClose} onClick={close}>Tutup</Button></div>
    </div>
  );
}

// Ganti password: dipakai untuk kewajiban ganti password awal (halaman penuh) dan untuk ganti kapan saja (modal di Pengaturan).
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAction } from '@/api/queries';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { IconCheck, IconClose, IconLock } from '@/components/icons';
import { post } from '@/lib/api';

export const DEFAULT_PASSWORD = '123456';
export const MIN_LENGTH = 12;

/** Aturan password baru, dalam urutan yang ditampilkan. `ok` hanya benar bila seluruh aturan terpenuhi. */
export function passwordRules(current: string, next: string, again: string): Array<{ label: string; ok: boolean }> {
  return [
    { label: `Minimal ${MIN_LENGTH} karakter`, ok: next.length >= MIN_LENGTH },
    { label: 'Berbeda dari password saat ini', ok: next !== '' && next !== current },
    { label: `Bukan password awal (${DEFAULT_PASSWORD})`, ok: next !== '' && next !== DEFAULT_PASSWORD },
    { label: 'Pengulangan cocok', ok: next !== '' && next === again }
  ];
}

export function ChangePasswordForm({ forced = false, onCancel }: { forced?: boolean; onCancel?: () => void }) {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [again, setAgain] = useState('');
  const client = useQueryClient(), navigate = useNavigate();
  const rules = passwordRules(current, next, again), valid = current !== '' && rules.every((r) => r.ok);
  const change = useAction(() => post('/api/account/password', { current, next }), {
    success: 'Password diganti. Silakan masuk dengan password baru.',
    onSuccess: () => { client.clear(); navigate('/login', { replace: true }); }   // semua sesi lama dicabut server
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (valid) void change.mutateAsync(); };
  return (
    <form className="form" onSubmit={submit} autoComplete="off">
      <Field label={forced ? 'Password saat ini (password awal)' : 'Password saat ini'}><input type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field label="Password baru"><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      <Field label="Ulangi password baru"><input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
      <ul className="rules" aria-label="Syarat password baru">
        {rules.map((r) => <li key={r.label} className={r.ok ? 'ok' : ''}>{r.ok ? <IconCheck size={14} aria-hidden /> : <IconClose size={14} aria-hidden />}<span>{r.label}</span></li>)}
      </ul>
      <div className="row">
        <button type="submit" className="primary" disabled={!valid || change.isPending}><IconLock size={16} aria-hidden />Ganti password</button>
        {onCancel && <Button icon={IconClose} onClick={onCancel}>Batal</Button>}
      </div>
    </form>
  );
}

/** Menggantikan seluruh aplikasi selama password awal belum diganti. */
export function ForcedPasswordChange() {
  const client = useQueryClient(), navigate = useNavigate();
  const logout = async () => { await post('/api/logout').catch(() => undefined); client.clear(); navigate('/login', { replace: true }); };
  return (
    <div className="login-wrap">
      <div className="login-card" role="main">
        <div className="login-logo"><Logo size={48} /></div>
        <h1>Ganti password awal</h1>
        <p className="note">Anda masuk dengan password awal. Demi keamanan, buat password baru sebelum memakai aplikasi. Aplikasi ini menyimpan kunci SSH dan kredensial server Anda.</p>
        <ChangePasswordForm forced />
        <button type="button" className="linklike" style={{ marginTop: 10 }} onClick={logout}>Keluar</button>
      </div>
    </div>
  );
}

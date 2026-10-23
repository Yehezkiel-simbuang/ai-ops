import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { q } from '@/api/queries';
import { Logo } from '@/components/Logo';
import type { User } from '@/api/types';
import { Field, useForm } from '@/components/ui/Field';
import { post } from '@/lib/api';

export function LoginPage() {
  const { values, bind } = useForm({ username: '', password: '' });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const client = useQueryClient(), navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const r = await post<{ user: User }>('/api/login', values);
      client.setQueryData(q.me().queryKey, r.user);   // sesi baru: jangan menunggu pengambilan ulang
      navigate('/', { replace: true });
    } catch (err) { setError((err as Error).message || 'Gagal masuk'); setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit} autoComplete="on">
        <div className="login-logo"><Logo size={56} /></div>
        <h1>AI Ops</h1>
        <p className="note">Masuk untuk mengelola server dan agen setup.</p>
        <Field label="Pengguna"><input name="username" autoComplete="username" required autoFocus {...bind('username')} /></Field>
        <Field label="Password"><input name="password" type="password" autoComplete="current-password" required {...bind('password')} /></Field>
        <button className="primary" type="submit" disabled={busy} style={{ justifyContent: 'center' }}>Masuk</button>
        {error && <p className="err" role="alert">{error}</p>}
      </form>
    </div>
  );
}

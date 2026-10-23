import { useState, type ChangeEvent, type ReactNode } from 'react';

/** Label + kontrol formulir. Teks bantuan opsional di bawah. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="lbl">{hint}</span>}
    </label>
  );
}

type Values = Record<string, string | number | boolean>;
type Element = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** State formulir sederhana: `bind('nama')` menghasilkan { value, onChange } untuk input/select/textarea (checkbox lewat `bindCheck`). */
export function useForm<T extends Values>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const set = <K extends keyof T>(key: K, value: T[K]) => setValues((v) => ({ ...v, [key]: value }));
  const bind = (key: keyof T) => ({
    value: values[key] as string | number,
    onChange: (e: ChangeEvent<Element>) => set(key, e.target.value as T[keyof T])
  });
  const bindCheck = (key: keyof T) => ({
    checked: Boolean(values[key]),
    onChange: (e: ChangeEvent<HTMLInputElement>) => set(key, e.target.checked as T[keyof T])
  });
  return { values, set, bind, bindCheck, reset: (next: T = initial) => setValues(next) };
}

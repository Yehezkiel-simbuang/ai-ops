// Toast global tanpa konteks React: bisa dipanggil dari mana saja (termasuk penanganan galat query).
import { useSyncExternalStore } from 'react';

export interface ToastState { message: string; bad: boolean; id: number }

let state: ToastState | null = null, timer: ReturnType<typeof setTimeout> | undefined, seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(message: string, bad = false): void {
  state = { message, bad, id: ++seq };
  clearTimeout(timer); timer = setTimeout(() => { state = null; emit(); }, 4500);
  emit();
}

export function useToast(): ToastState | null {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => state);
}

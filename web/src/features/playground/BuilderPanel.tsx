// Perakit susunan: pilih komponen (aplikasi, replika, load balancer, database, Redis, batas sumber daya) dan hasilkan docker-compose.yml.
import { useState } from 'react';
import { useAction } from '@/api/queries';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { IconWrench } from '@/components/icons';
import { post } from '@/lib/api';
import type { ComposeAnalysis } from './types';

export interface BuilderForm {
  image: string; port: number; replicas: number; lb: 'nginx' | 'haproxy'; db: '' | 'postgres' | 'mysql'; redis: boolean;
  cpus: string; memory: string; dbMemory: string; healthPath: string; publishPort: number;
}
export const BUILDER_DEFAULT: BuilderForm = { image: '', port: 80, replicas: 1, lb: 'nginx', db: '', redis: false, cpus: '', memory: '', dbMemory: '', healthPath: '', publishPort: 8080 };

/** Muatan untuk POST /api/playground/build; kolom kosong tidak dikirim. */
export function builderPayload(f: BuilderForm) {
  const limits = (cpus: string, memory: string) => ({ ...(cpus.trim() ? { cpus: Number(cpus) } : {}), ...(memory.trim() ? { memory: memory.trim() } : {}) });
  return {
    app: { image: f.image.trim(), port: f.port, replicas: f.replicas, limits: limits(f.cpus, f.memory), healthPath: f.healthPath.trim() },
    db: f.db ? { kind: f.db, limits: limits('', f.dbMemory) } : null, redis: f.redis ? {} : null, lb: f.lb, publishPort: f.publishPort
  };
}

export function BuilderPanel({ onBuilt, onClose }: { onBuilt: (compose: string, healthPath: string) => void; onClose: () => void }) {
  const [f, setF] = useState<BuilderForm>(BUILDER_DEFAULT), set = (p: Partial<BuilderForm>) => setF((x) => ({ ...x, ...p }));
  const build = useAction(() => post<{ compose: string; analysis: ComposeAnalysis }>('/api/playground/build', builderPayload(f)), { onSuccess: (r) => { onBuilt(r.compose, f.healthPath.trim()); onClose(); } });
  const num = (k: 'port' | 'replicas' | 'publishPort') => (e: React.ChangeEvent<HTMLInputElement>) => set({ [k]: Number(e.target.value) } as Partial<BuilderForm>);
  return (
    <div className="panel form" aria-label="Perakit susunan">
      <h3><IconWrench size={16} aria-hidden />Rakit dari komponen</h3>
      <div className="cols tight">
        <Field label="Image aplikasi"><input className="mono" placeholder="ghcr.io/akun/aplikasi:1.0" value={f.image} onChange={(e) => set({ image: e.target.value })} /></Field>
        <Field label="Port di dalam aplikasi"><input type="number" min={1} max={65535} value={f.port} onChange={num('port')} /></Field>
      </div>
      <div className="cols tight">
        <Field label="Jumlah replika aplikasi (1-4)"><input type="number" min={1} max={4} value={f.replicas} onChange={num('replicas')} /></Field>
        {f.replicas > 1 && <Field label="Load balancer"><select value={f.lb} onChange={(e) => set({ lb: e.target.value as BuilderForm['lb'] })}><option value="nginx">Nginx</option><option value="haproxy">HAProxy</option></select></Field>}
        <Field label="Database"><select aria-label="Database" value={f.db} onChange={(e) => set({ db: e.target.value as BuilderForm['db'] })}><option value="">Tanpa database</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select></Field>
      </div>
      <label className="checkline"><input type="checkbox" checked={f.redis} onChange={(e) => set({ redis: e.target.checked })} /><span>Tambah Redis (REDIS_URL diisi otomatis)</span></label>
      <div className="cols tight">
        <Field label="Batas CPU aplikasi (opsional)" hint="mis. 0.5"><input className="mono" value={f.cpus} onChange={(e) => set({ cpus: e.target.value })} /></Field>
        <Field label="Batas memori aplikasi (opsional)" hint="mis. 512m"><input className="mono" value={f.memory} onChange={(e) => set({ memory: e.target.value })} /></Field>
        {f.db && <Field label="Batas memori database (opsional)"><input className="mono" value={f.dbMemory} onChange={(e) => set({ dbMemory: e.target.value })} /></Field>}
      </div>
      <div className="cols tight">
        <Field label="Path cek kesehatan"><input className="mono" placeholder="/health" value={f.healthPath} onChange={(e) => set({ healthPath: e.target.value })} /></Field>
        <Field label="Port di server (dibuka)"><input type="number" min={1024} max={65535} value={f.publishPort} onChange={num('publishPort')} /></Field>
      </div>
      <p className="lbl">Aplikasi menerima DATABASE_URL dan REDIS_URL. Database memakai akun uji <code>app/app</code>, jadi pastikan aplikasi Anda membaca variabel itu. Compose hasilnya bisa Anda ubah lagi di kotak di bawah.</p>
      <div className="row"><Button primary disabled={!f.image.trim()} onClick={() => build.mutateAsync()}>Buat Compose</Button><Button onClick={onClose}>Batal</Button></div>
    </div>
  );
}

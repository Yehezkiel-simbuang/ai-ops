import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { q, useAction } from '@/api/queries';
import { Async } from '@/components/ui/Async';
import { DataTable } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { ChangePasswordForm } from '@/features/auth/ChangePassword';
import { Modal } from '@/components/ui/Modal';
import { Note, PageHead, Section, Tabs } from '@/components/ui/Layout';
import { IconCpu, IconHistory, IconLock, IconNetwork, IconScale, IconShield, IconSliders } from '@/components/icons';
import { post } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { ChannelsPanel } from './ChannelsPanel';
import { PricesPanel } from './PricesPanel';
import { ProvidersPanel } from './ProvidersPanel';
import { RolesPanel } from './RolesPanel';

function MonitoringSecurity() {
  const settings = useQuery(q.settings());
  const save = useAction((auto_report: boolean) => post('/api/settings', { auto_report }), { success: 'Disimpan', invalidate: [['settings']] });
  return (
    <Section title="Monitoring dan keamanan" icon={IconShield}>
      <label className="checkline">
        <input type="checkbox" checked={settings.data?.auto_report ?? false} onChange={(e) => save.mutate(e.target.checked)} />
        <span>Buat laporan model Monitoring otomatis saat ada peringatan baru (maks. satu per 30 menit per server; memakai token)</span>
      </label>
      <div className="lbl" style={{ marginTop: 8 }}>Perintah baca dijalankan otomatis, perintah yang mengubah sesuatu selalu butuh persetujuan, perintah merusak diblokir.</div>
    </Section>
  );
}

function Account() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Akun" icon={IconLock}>
      <div className="row"><Button icon={IconLock} onClick={() => setOpen(true)}>Ganti password</Button></div>
      <div className="lbl" style={{ marginTop: 8 }}>Setelah diganti, semua sesi masuk dicabut dan Anda perlu masuk lagi.</div>
      <Modal open={open} onClose={() => setOpen(false)}><h2><IconLock size={16} aria-hidden />Ganti password</h2><ChangePasswordForm onCancel={() => setOpen(false)} /></Modal>
    </Section>
  );
}

function AuditTrail() {
  const audit = useQuery(q.audit());
  return (
    <Section title="Jejak audit" icon={IconHistory}>
      <Async query={audit}>{(rows) => <DataTable textCols={4} heads={['waktu', 'pelaku', 'aksi', 'detail']} empty="Belum ada." rows={rows.slice(0, 30).map((a) => [dateTime(a.ts), a.actor, a.action, a.detail])} />}</Async>
    </Section>
  );
}

type SettingsTab = 'ai' | 'notif' | 'akun' | 'audit';
const TABS: Array<{ id: SettingsTab; label: string }> = [{ id: 'ai', label: 'Model AI' }, { id: 'notif', label: 'Notifikasi' }, { id: 'akun', label: 'Akun dan keamanan' }, { id: 'audit', label: 'Jejak audit' }];

export function SettingsPage() {
  const config = useQuery(q.config()), usage = useQuery(q.usage(30));
  const [params, setParams] = useSearchParams(), tab: SettingsTab = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as SettingsTab) : 'ai';
  return (
    <>
      <PageHead title="Pengaturan" icon={IconSliders} />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} tabs={TABS} />
      <Async query={config}>{(c) => (
        <>
          {tab === 'ai' && <div className="cols wide-left">
            <div>
              <h2><IconCpu size={16} aria-hidden />Model per peran</h2>
              <Note>Tiap peran bisa memakai penyedia dan model berbeda, mis. model kuat untuk setup dan model murah untuk monitoring.</Note>
              <div style={{ marginTop: 12 }}><RolesPanel config={c} /></div>
              <h2 className="mt"><IconScale size={16} aria-hidden />Harga per 1 juta token (opsional)</h2>
              <PricesPanel config={c} usedModels={Object.keys(usage.data?.byModel ?? {})} />
            </div>
            <div>
              <h2><IconNetwork size={16} aria-hidden />Penyedia dan API key</h2>
              <ProvidersPanel config={c} />
            </div>
          </div>}
          {tab === 'notif' && <ChannelsPanel />}
          {tab === 'akun' && <><Account /><MonitoringSecurity /></>}
          {tab === 'audit' && <AuditTrail />}
        </>
      )}</Async>
    </>
  );
}

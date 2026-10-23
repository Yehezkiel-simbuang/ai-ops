// Kartu persetujuan satu perintah dari agen setup (dipakai di Ringkasan dan di detail proses).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAction } from '@/api/queries';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconBan, IconCheck, IconLock } from '@/components/icons';
import { post } from '@/lib/api';

interface Props { command: { id: number; command: string; purpose: string; reason: string }; runId?: string; runName?: string | null }

export function ApprovalCard({ command, runId, runName }: Props) {
  const [reason, setReason] = useState('');
  const invalidate = [['overview'], ['runs']];
  const approve = useAction(() => post(`/api/commands/${command.id}/approve`), { success: 'Perintah dijalankan', invalidate });
  const reject = useAction(() => post(`/api/commands/${command.id}/reject`, { reason }), { success: 'Perintah ditolak', invalidate });
  return (
    <div className="card wait">
      <div className="hd">
        <Badge tone="warn" icon={IconLock}>Perlu persetujuan</Badge>
        {runName && runId && <Link to={`/setup/${runId}`}>{runName}</Link>}
      </div>
      <div className="bd">
        {command.purpose && <div className="thought">{command.purpose}</div>}
        <pre className="cmd">{command.command}</pre>
        {command.reason && <div className="lbl">Kebijakan: {command.reason}</div>}
        <div className="row">
          <Button primary icon={IconCheck} onClick={() => approve.mutateAsync()}>Setujui dan jalankan</Button>
          <Button icon={IconBan} onClick={() => reject.mutateAsync()}>Tolak</Button>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="alasan bila ditolak (opsional)" aria-label="Alasan penolakan" style={{ flex: '1 1 200px', minWidth: 0 }} />
        </div>
      </div>
    </div>
  );
}

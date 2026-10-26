// Halaman uji beban baru (/uji-beban/baru). Dari Playground, alamat target, nama, dan susunan terisi lewat parameter alamat.
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageHead } from '@/components/ui/Layout';
import { IconGauge } from '@/components/icons';
import { NewLoadTestForm } from './NewLoadTestForm';
import { loadQ } from './queries';

export function NewLoadTestPage() {
  const [params] = useSearchParams(), navigate = useNavigate(), status = useQuery(loadQ.status());
  const prefill = { target: params.get('target') ?? undefined, name: params.get('nama') ?? undefined, playgroundId: Number(params.get('pg')) || undefined };
  return (
    <>
      <PageHead title="Uji beban baru" icon={IconGauge}><Link to="/uji-beban">Kembali ke daftar</Link></PageHead>
      <NewLoadTestForm status={status.data} prefill={prefill} onCreated={(id) => navigate(`/uji-beban/${id}`)} onCancel={() => navigate('/uji-beban')} />
    </>
  );
}

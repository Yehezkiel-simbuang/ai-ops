// Harga per 1 juta token (opsional) untuk menghitung perkiraan biaya.
import { useState } from 'react';
import { useAction } from '@/api/queries';
import type { AppConfig } from '@/api/types';
import { Empty, Item, List } from '@/components/ui/Layout';
import { post } from '@/lib/api';

function PriceRow({ id, price }: { id: string; price?: { in: number | null; out: number | null } }) {
  const [input, setInput] = useState(price?.in == null ? '' : String(price.in)), [output, setOutput] = useState(price?.out == null ? '' : String(price.out));
  const slash = id.indexOf('/'), provider = id.slice(0, slash), model = id.slice(slash + 1);
  const save = useAction(() => post('/api/price', { provider, model, in: input, out: output }), { invalidate: [['config'], ['usage']] });
  const field = (value: string, set: (v: string) => void, label: string) =>
    <input type="number" min={0} step="any" className="input-md" placeholder={label} aria-label={`${label} ${id}`} value={value} onChange={(e) => set(e.target.value)} onBlur={() => save.mutate()} />;
  return (
    <Item top title={<span className="mono" style={{ fontSize: '.84rem' }}>{id}</span>}>
      {field(input, setInput, 'masuk')}{field(output, setOutput, 'keluar')}<span className="lbl">USD / 1 jt token</span>
    </Item>
  );
}

export function PricesPanel({ config, usedModels }: { config: AppConfig; usedModels: string[] }) {
  const ids = new Set<string>([...Object.values(config.roles).map((r) => `${r.provider}/${r.model}`), ...usedModels, ...Object.keys(config.prices)]);
  if (!ids.size) return <Empty>Atur model pada peran dulu.</Empty>;
  return <List>{[...ids].map((id) => <PriceRow key={id} id={id} price={config.prices[id]} />)}</List>;
}

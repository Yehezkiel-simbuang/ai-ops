// Diagram langsung selama uji berjalan (dan putar ulang sesudahnya): garis bergerak antar komponen dan pemakaian CPU nyata tiap kontainer.
// Angka berasal dari sampel docker stats yang diambil server tiap ±5 detik, bukan simulasi. Kecepatan garis mengikuti jumlah pengguna virtual tahap
// yang sedang berjalan; laju request terukur (req/dtk) baru ada setelah tahap selesai dan dilaporkan runner, jadi tidak ditampilkan di sini.
import { Button } from '@/components/ui/Button';
import { IconPause, IconPlay, IconReset } from '@/components/icons';
import { SPEEDS, usePlayback } from '../lab/Playback';
import { ArchitectureDiagram, Legend } from './ArchitectureView';
import type { Architecture, Live } from './types';

const STALE_S = 20;   // sampel lebih tua dari ini: ada yang tertunda, beri tahu

export function LiveFlow({ arch, live, now = Date.now() }: { arch: Architecture; live: Live | null | undefined; now?: number }) {
  const age = live ? Math.max(0, Math.round((now - live.at) / 1000)) : null;
  return (
    <div className="stack">
      <p className="lbl" role="status">
        {live
          ? <>Tahap {live.stageIdx + 1}{live.vus != null ? `: ${live.vus} pengguna virtual (tahap terbesar ${live.maxVus})` : ''}. Pemakaian dari sampel {age} dtk lalu{age != null && age > STALE_S ? '; pengambilan sampel tertunda' : ''}.</>
          : 'Menunggu sampel pertama dari server uji (diambil tiap ±5 detik). Garis mulai bergerak setelah ada sampel.'}
      </p>
      <ArchitectureDiagram boxes={arch.current} edges={arch.edges} label="Aliran data langsung" live={live ?? null} />
      {live?.host && <p className="lbl">Server uji: CPU {Math.round(live.host.cpu * 100)}% dari {live.host.cores} core{live.host.mem != null ? `, memori ${Math.round(live.host.mem * 100)}%` : ''}.</p>}
      <Legend />
      <p className="lbl">Bilah dan angka di tiap kotak = pemakaian CPU nyata kontainer itu terhadap kapasitasnya (kuning mulai 60%, merah mulai 85%). Garis bergerak lebih cepat saat pengguna virtual lebih banyak; semua garis memakai kecepatan yang sama karena laju per garis tidak diukur.</p>
    </div>
  );
}

/** Putar ulang uji yang sudah selesai: bingkai dari sampel tersimpan (CPU nyata tiap kontainer), diputar dengan tombol, penggeser waktu, dan kecepatan. */
export function LiveReplay({ arch, frames }: { arch: Architecture; frames: Live[] }) {
  const pb = usePlayback(frames.length, `${frames.length}:${frames[0]?.at ?? 0}`);   // kunci stabil: data yang diambil ulang tidak mengulang dari awal
  const f = frames[pb.index], t0 = frames[0]?.at ?? 0;
  if (!f) return null;
  const sec = Math.round((f.at - t0) / 1000), total = Math.round(((frames[frames.length - 1]?.at ?? t0) - t0) / 1000);
  return (
    <div className="stack">
      <p className="lbl" role="status">Tahap {f.stageIdx + 1}{f.vus != null ? `: ${f.vus} pengguna virtual` : ''} | detik {sec} dari {total} sejak sampel pertama.</p>
      <ArchitectureDiagram boxes={arch.current} edges={arch.edges} label="Putar ulang aliran data" live={f} />
      <div className="playbar">
        <Button icon={pb.playing ? IconPause : IconPlay} aria-label={pb.playing ? 'Jeda' : 'Putar'} onClick={pb.toggle}>{pb.playing ? 'Jeda' : 'Putar'}</Button>
        <Button icon={IconReset} aria-label="Ulang dari awal" onClick={pb.restart} />
        <input type="range" min={0} max={frames.length - 1} value={pb.index} aria-label="Waktu uji" onChange={(e) => pb.seek(Number(e.target.value))} />
        <span className="mono lbl" style={{ minWidth: 70 }}>{pb.index + 1}/{frames.length}</span>
        <select aria-label="Kecepatan" value={pb.speed} onChange={(e) => pb.setSpeed(Number(e.target.value))}>{SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}</select>
      </div>
      <p className="lbl">Diputar dari sampel pemakaian yang tersimpan selama uji (tiap ±5 detik), bukan rekaman layar. Garis bergerak mengikuti jumlah pengguna virtual tahap itu.</p>
    </div>
  );
}

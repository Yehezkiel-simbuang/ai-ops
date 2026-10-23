// Pemutaran simulasi: tombol putar/jeda, kecepatan, penggeser waktu, dan grafik waktu respons (awal vs eksperimen).
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconPause, IconPlay, IconReset } from '@/components/icons';
import type { LabFrame } from './types';

export const SPEEDS = [1, 2, 4, 8];

/** Indeks bingkai yang sedang ditampilkan. Mulai dari awal dan berhenti di akhir; `restartKey` berubah = mulai lagi. */
export function usePlayback(length: number, restartKey: unknown) {
  const [index, setIndex] = useState(0), [playing, setPlaying] = useState(true), [speed, setSpeed] = useState(2);
  useEffect(() => { setIndex(0); setPlaying(true); }, [restartKey]);
  useEffect(() => {
    if (!playing || length <= 1) return;
    const id = setInterval(() => setIndex((i) => { if (i + 1 >= length) { setPlaying(false); return length - 1; } return i + 1; }), 500 / speed);
    return () => clearInterval(id);
  }, [playing, speed, length]);
  const seek = (i: number) => { setPlaying(false); setIndex(Math.max(0, Math.min(length - 1, i))); };
  const toggle = () => { if (index >= length - 1) { setIndex(0); setPlaying(true); } else setPlaying((p) => !p); };
  return { index: Math.min(index, Math.max(0, length - 1)), playing, speed, setSpeed, seek, toggle, restart: () => { setIndex(0); setPlaying(true); } };
}

const W = 600, H = 110, PAD_L = 34, PAD_B = 16;

/** Dua garis p95 per detik; klik untuk melompat ke waktu tertentu. */
export function Timeline({ base, exp, index, onSeek }: { base: LabFrame[]; exp: LabFrame[]; index: number; onSeek: (i: number) => void }) {
  const n = Math.max(base.length, exp.length, 2), max = Math.max(1, ...base.map((f) => f.p95), ...exp.map((f) => f.p95));
  const x = (i: number) => PAD_L + (i / (n - 1)) * (W - PAD_L - 4), y = (v: number) => 6 + (1 - v / max) * (H - PAD_B - 10);
  const line = (fs: LabFrame[]) => fs.map((f, i) => `${x(i).toFixed(1)},${y(f.p95).toFixed(1)}`).join(' ');
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    onSeek(Math.round(((px - PAD_L) / (W - PAD_L - 4)) * (n - 1)));
  };
  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Waktu respons p95 per detik, kondisi awal dan eksperimen" onClick={click}>
      <line className="grid" x1={PAD_L} x2={W} y1={y(0)} y2={y(0)} /><line className="grid" x1={PAD_L} x2={W} y1={y(max)} y2={y(max)} />
      <text x={2} y={y(max) + 8}>{max.toFixed(1)}s</text><text x={2} y={y(0)}>0</text>
      {base.length > 1 && <polyline className="s-base" points={line(base)} />}
      {exp.length > 1 && <polyline className="s-exp" points={line(exp)} />}
      <line className="cursor" x1={x(index)} x2={x(index)} y1={4} y2={H - PAD_B} />
    </svg>
  );
}

interface PlaybarProps { pb: ReturnType<typeof usePlayback>; length: number; time: number }

export function Playbar({ pb, length, time }: PlaybarProps) {
  return (
    <div className="playbar">
      <Button icon={pb.playing ? IconPause : IconPlay} aria-label={pb.playing ? 'Jeda' : 'Putar'} onClick={pb.toggle}>{pb.playing ? 'Jeda' : 'Putar'}</Button>
      <Button icon={IconReset} aria-label="Ulang dari awal" onClick={pb.restart} />
      <input type="range" min={0} max={Math.max(0, length - 1)} value={pb.index} aria-label="Waktu simulasi" onChange={(e) => pb.seek(Number(e.target.value))} />
      <span className="mono lbl" style={{ minWidth: 78 }}>detik {time}/{length}</span>
      <select aria-label="Kecepatan" value={pb.speed} onChange={(e) => pb.setSpeed(Number(e.target.value))}>{SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}</select>
    </div>
  );
}

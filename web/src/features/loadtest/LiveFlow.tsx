// Diagram langsung selama uji berjalan: garis bergerak antar komponen dan pemakaian CPU nyata tiap kontainer.
// Angka berasal dari sampel docker stats yang diambil server tiap ±5 detik, bukan simulasi. Kecepatan garis mengikuti jumlah pengguna virtual tahap
// yang sedang berjalan; laju request terukur (req/dtk) baru ada setelah tahap selesai dan dilaporkan runner, jadi tidak ditampilkan di sini.
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

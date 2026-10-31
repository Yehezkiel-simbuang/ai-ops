-- Waktu insiden memakai jam kejadian di agen, bukan jam tiba di server. Sebelumnya kejadian yang tertunda di spool agen (aplikasi mati) tampil seolah baru terjadi saat
-- agen tersambung lagi. Insiden lama diperbaiki dari agent_events, yang masih menyimpan jam asli (ts, detik) dan jam tiba (received, ms).
-- Pasangan insiden dan kejadiannya = kejadian terakhir dengan received <= jam tercatat (selisih kecil: jam tercatat diambil sesaat sesudah received); karena kejadian
-- dari spool diproses berurutan, kejadian tetangga dalam satu gelombang tidak tertukar. Tanpa pasangan (kejadian sudah dibersihkan), nilainya dibiarkan.

UPDATE incidents i SET opened = LEAST(i.opened, COALESCE((
  SELECT e.ts * 1000 FROM agent_events e
   WHERE e.server_id = i.server_id AND e.key = i.key AND e.type IN ('open', 'still_open') AND e.received <= i.opened AND e.received > i.opened - 10000
   ORDER BY e.received DESC LIMIT 1), i.opened));

UPDATE incidents i SET resolved_at = GREATEST(i.opened, LEAST(i.resolved_at, COALESCE((
  SELECT e.ts * 1000 FROM agent_events e
   WHERE e.server_id = i.server_id AND e.key = i.key AND e.type = 'resolved' AND e.received <= i.resolved_at AND e.received > i.resolved_at - 10000
   ORDER BY e.received DESC LIMIT 1), i.resolved_at)))
 WHERE i.resolved_at IS NOT NULL;

UPDATE incidents i SET last_event = CASE
  WHEN i.status = 'resolved' AND i.resolved_at IS NOT NULL THEN i.resolved_at
  ELSE GREATEST(i.opened, LEAST(i.last_event, COALESCE((
    SELECT MAX(e.ts) * 1000 FROM agent_events e WHERE e.server_id = i.server_id AND e.key = i.key AND e.type <> 'resolved' AND e.received <= i.last_event), i.last_event)))
END;

-- peringatan dari agen: sama, dicocokkan langsung ke kejadian yang membukanya (peringatan dibuat sesaat sesudah kejadian diterima)
UPDATE alerts a SET ts = LEAST(a.ts, COALESCE((
  SELECT e.ts * 1000 FROM agent_events e
   WHERE e.server_id = a.server_id AND 'ag:' || e.key = a.key AND e.type IN ('open', 'still_open') AND e.received <= a.ts AND e.received > a.ts - 10000
   ORDER BY e.received DESC LIMIT 1), a.ts))
 WHERE a.source = 'agent';

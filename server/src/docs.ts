// Dokumentasi server: profil (fungsi, lingkungan, pemilik, runbook), alamat, layanan, dependensi, pencarian inventaris,
// fakta otomatis dari server (hanya-baca), dan ekspor Markdown/CSV TANPA rahasia.
import { isIP } from 'node:net';
import { audit, bad, db, HttpError } from './context.js';
import * as Servers from './servers.js';

export const ENVS = ['prod', 'staging', 'dev', 'lab', 'other'] as const;
export const ADDR_KINDS = ['ip', 'hostname', 'url', 'mac', 'other'] as const;
export interface AddressIn { label?: string; kind?: string; address: string; is_primary?: boolean; notes?: string }
export interface ServiceIn { name: string; port?: number | null; protocol?: string; url?: string; notes?: string }
export interface ProfileIn { purpose?: string; environment?: string; tags?: string[]; location?: string; owner?: string; runbook?: string; addresses?: AddressIn[]; services?: ServiceIn[]; dependsOn?: Array<{ id: number; note?: string }> }

const cut = (s: unknown, n: number): string => String(s ?? '').trim().slice(0, n);
function cleanTags(t: unknown): string[] {
  const out: string[] = []; for (const x of Array.isArray(t) ? t : []) { const v = cut(x, 30).toLowerCase().replace(/\s+/g, '-'); if (v && /^[a-z0-9._:-]+$/.test(v) && !out.includes(v)) out.push(v); }
  return out.slice(0, 20);
}
function cleanAddresses(list: AddressIn[]): Array<Required<AddressIn>> {
  const out = (list ?? []).slice(0, 40).map((a) => {
    const kind = (ADDR_KINDS as readonly string[]).includes(a.kind ?? '') ? a.kind! : (isIP(String(a.address ?? '').trim()) ? 'ip' : 'hostname'), address = cut(a.address, 200);
    if (!address) throw bad('Alamat tidak boleh kosong');
    if (kind === 'ip' && !isIP(address)) throw bad(`"${address}" bukan alamat IP yang valid`);
    if (kind === 'mac' && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(address)) throw bad(`"${address}" bukan MAC yang valid`);
    return { label: cut(a.label, 60), kind, address, is_primary: !!a.is_primary, notes: cut(a.notes, 300) } as Required<AddressIn>;
  });
  let seen = false; for (const a of out) { if (a.is_primary) { if (seen) a.is_primary = false; seen = true; } }
  if (!seen) { const ip = out.find((a) => a.kind === 'ip'); if (ip) ip.is_primary = true; }
  return out;
}
function cleanServices(list: ServiceIn[]): Array<{ name: string; port: number | null; protocol: string; url: string; notes: string }> {
  return (list ?? []).slice(0, 60).map((s) => {
    const name = cut(s.name, 80); if (!name) throw bad('Nama layanan tidak boleh kosong');
    const port = s.port == null || (s.port as unknown) === '' ? null : Number(s.port); if (port != null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) throw bad(`Port layanan "${name}" tidak valid`);
    return { name, port, protocol: ['tcp', 'udp'].includes(String(s.protocol)) ? String(s.protocol) : 'tcp', url: cut(s.url, 300), notes: cut(s.notes, 300) };
  });
}

export async function getProfile(serverId: number) {
  const s = await Servers.getPublic(serverId); if (!s) throw new HttpError(404, 'Server tidak ada');
  const [addresses, services, depends, dependents, creds, tasks] = await Promise.all([
    db().query('SELECT id,label,kind,address,is_primary,notes FROM server_addresses WHERE server_id=$1 ORDER BY is_primary DESC, id', [serverId]),
    db().query('SELECT id,name,port,protocol,url,notes FROM server_services WHERE server_id=$1 ORDER BY port NULLS LAST, name', [serverId]),
    db().query('SELECT d.depends_on AS id, s.name, d.note FROM server_dependencies d JOIN servers s ON s.id=d.depends_on WHERE d.server_id=$1 ORDER BY s.name', [serverId]),
    db().query('SELECT d.server_id AS id, s.name, d.note FROM server_dependencies d JOIN servers s ON s.id=d.server_id WHERE d.depends_on=$1 ORDER BY s.name', [serverId]),
    db().one<{ c: number }>('SELECT COUNT(*)::int AS c FROM credentials WHERE server_id=$1', [serverId]),
    db().one<{ c: number; o: number }>('SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE due_at<$2)::int AS o FROM maintenance_tasks WHERE server_id=$1 AND enabled', [serverId, Date.now()])
  ]);
  return { server: s, addresses, services, depends, dependents, counts: { credentials: creds?.c ?? 0, tasks: tasks?.c ?? 0, overdue: tasks?.o ?? 0 } };
}

export async function updateProfile(serverId: number, p: ProfileIn, by: string): Promise<void> {
  if (!(await Servers.get(serverId))) throw new HttpError(404, 'Server tidak ada');
  if (p.environment !== undefined && !(ENVS as readonly string[]).includes(p.environment)) throw bad('Lingkungan harus prod, staging, dev, lab, atau other');
  const addrs = p.addresses ? cleanAddresses(p.addresses) : null, svcs = p.services ? cleanServices(p.services) : null;
  const deps = p.dependsOn ? [...new Map(p.dependsOn.map((d) => [Number(d.id), cut(d.note, 200)])).entries()].filter(([id]) => id !== serverId) : null;
  await db().tx(async (t) => {
    const sets: string[] = ['doc_updated=$1'], args: unknown[] = [Date.now()];
    const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col}=$${args.length}`); };
    if (p.purpose !== undefined) set('purpose', cut(p.purpose, 600)); if (p.environment !== undefined) set('environment', p.environment); if (p.tags !== undefined) set('tags', cleanTags(p.tags));
    if (p.location !== undefined) set('location', cut(p.location, 200)); if (p.owner !== undefined) set('owner', cut(p.owner, 200)); if (p.runbook !== undefined) set('runbook', cut(p.runbook, 30000));
    args.push(serverId); await t.exec(`UPDATE servers SET ${sets.join(', ')} WHERE id=$${args.length}`, args);
    if (addrs) { await t.exec('DELETE FROM server_addresses WHERE server_id=$1', [serverId]); for (const a of addrs) await t.exec('INSERT INTO server_addresses(server_id,label,kind,address,is_primary,notes) VALUES($1,$2,$3,$4,$5,$6)', [serverId, a.label, a.kind, a.address, a.is_primary, a.notes]); }
    if (svcs) { await t.exec('DELETE FROM server_services WHERE server_id=$1', [serverId]); for (const s of svcs) await t.exec('INSERT INTO server_services(server_id,name,port,protocol,url,notes) VALUES($1,$2,$3,$4,$5,$6)', [serverId, s.name, s.port, s.protocol, s.url, s.notes]); }
    if (deps) { await t.exec('DELETE FROM server_dependencies WHERE server_id=$1', [serverId]); for (const [id, note] of deps) { if (!(await t.one('SELECT 1 AS x FROM servers WHERE id=$1', [id]))) throw bad('Server dependensi tidak ada'); await t.exec('INSERT INTO server_dependencies(server_id,depends_on,note) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [serverId, id, note]); } }
  });
  await audit(by, 'dokumentasi.ubah', `server ${serverId}`);
}

// ---------- inventaris dan pencarian ("IP-nya apa, usernamenya apa, ini server buat apa")
export interface InventoryQuery { q?: string; env?: string; tag?: string }
export async function inventory(f: InventoryQuery = {}) {
  const where: string[] = [], args: unknown[] = [];
  if (f.env) { args.push(f.env); where.push(`s.environment=$${args.length}`); }
  if (f.tag) { args.push(f.tag.toLowerCase()); where.push(`$${args.length} = ANY(s.tags)`); }
  if (f.q && f.q.trim()) {
    args.push('%' + f.q.trim().replace(/[\\%_]/g, (m) => '\\' + m) + '%'); const n = args.length;
    where.push(`(s.name ILIKE $${n} OR s.host ILIKE $${n} OR s.purpose ILIKE $${n} OR s.owner ILIKE $${n} OR s.location ILIKE $${n} OR s.notes ILIKE $${n} OR s.username ILIKE $${n} OR array_to_string(s.tags,' ') ILIKE $${n}
      OR EXISTS (SELECT 1 FROM server_addresses a WHERE a.server_id=s.id AND (a.address ILIKE $${n} OR a.label ILIKE $${n}))
      OR EXISTS (SELECT 1 FROM server_services v WHERE v.server_id=s.id AND (v.name ILIKE $${n} OR v.port::text ILIKE $${n}))
      OR EXISTS (SELECT 1 FROM credentials c WHERE c.server_id=s.id AND (c.username ILIKE $${n} OR c.label ILIKE $${n})))`);
  }
  const now = Date.now();
  return db().query(`SELECT s.id, s.name, s.host, s.port, s.username, s.purpose, s.environment, s.tags, s.location, s.owner, s.os_info, s.last_status, s.doc_updated, s.facts_at,
      (SELECT address FROM server_addresses a WHERE a.server_id=s.id ORDER BY is_primary DESC, id LIMIT 1) AS primary_address,
      (SELECT COUNT(*)::int FROM credentials c WHERE c.server_id=s.id) AS credentials,
      (SELECT COUNT(*)::int FROM credentials c WHERE c.server_id=s.id AND c.rotate_every_days IS NOT NULL AND c.rotated_at + c.rotate_every_days::bigint * 86400000 < ${now}) AS rotation_due,
      (SELECT MIN(due_at) FROM maintenance_tasks m WHERE m.server_id=s.id AND m.enabled) AS next_due,
      (SELECT COUNT(*)::int FROM maintenance_tasks m WHERE m.server_id=s.id AND m.enabled AND m.due_at < ${now}) AS overdue,
      (SELECT MAX(done_at) FROM maintenance_log l WHERE l.server_id=s.id) AS last_maintenance,
      (SELECT COUNT(*)::int FROM alerts al WHERE al.server_id=s.id AND NOT al.resolved) AS open_alerts
    FROM servers s ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.environment, s.name`, args);
}

// ---------- fakta otomatis (skrip hanya-baca konstan; tidak ada masukan pengguna di dalamnya)
export const FACTS_SCRIPT = [
  'echo "os=$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")"', 'echo "kernel=$(uname -r)"', 'echo "arch=$(uname -m)"', 'echo "hostname=$(hostname)"',
  'echo "uptime_d=$(awk \'{printf "%.1f", $1/86400}\' /proc/uptime)"', 'echo "cpu_cores=$(nproc)"', 'echo "cpu_model=$(grep -m1 \'model name\' /proc/cpuinfo | cut -d: -f2 | sed \'s/^ *//\')"',
  'echo "ram_mb=$(awk \'/MemTotal/{printf "%d", $2/1024}\' /proc/meminfo)"', 'echo "disk_root=$(df -hP / | awk \'NR==2{print $2" total, "$5" terpakai"}\')"',
  'echo "timezone=$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null)"',
  'ip -o -4 addr show scope global 2>/dev/null | awk \'{print "ip="$2" "$4}\'',
  'ss -ltnH 2>/dev/null | awk \'{n=split($4,a,":"); print "port="a[n]}\' | sort -un | head -40',
  'systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk \'{print "svc="$1}\' | head -60',
  'for c in nginx apache2 httpd mysql mysqld mariadb psql redis-server php docker zpool; do command -v $c >/dev/null 2>&1 && echo "tool=$c"; done',
  'if command -v apt-get >/dev/null 2>&1; then echo "updates=$(apt list --upgradable 2>/dev/null | tail -n +2 | wc -l)"; elif command -v dnf >/dev/null 2>&1; then echo "updates=$(dnf -q check-update 2>/dev/null | grep -cE \'^[A-Za-z0-9]\')"; fi',
  '[ -f /var/run/reboot-required ] && echo "reboot_required=1" || echo "reboot_required=0"'
].join('; ');

export function parseFacts(out: string) {
  const f: Record<string, any> = { ips: [], ports: [], services: [], tools: [] };
  for (const l of String(out).split('\n')) {
    const m = l.match(/^([a-z_]+)=(.*)$/); if (!m) continue; const k = m[1]!, v = m[2]!.trim();
    if (k === 'ip') f.ips.push(v); else if (k === 'port') { const n = Number(v); if (n > 0 && n < 65536) f.ports.push(n); } else if (k === 'svc') f.services.push(v.replace(/\.service$/, '')); else if (k === 'tool') f.tools.push(v);
    else if (['cpu_cores', 'ram_mb', 'updates'].includes(k)) f[k] = Number(v) || 0; else if (k === 'reboot_required') f.reboot_required = v === '1'; else f[k] = v.slice(0, 300);
  }
  return f;
}
export async function collectFacts(serverId: number, by: string) {
  const s = await Servers.get(serverId); if (!s) throw new HttpError(404, 'Server tidak ada');
  const r = await Servers.run(s, FACTS_SCRIPT, { timeoutMs: 40_000 });
  if (r.exitCode !== 0 && !r.stdout.trim()) throw bad('Tidak bisa membaca server lewat SSH: ' + (r.stderr || 'tanpa keluaran').trim().split('\n').slice(-1)[0]!.slice(0, 200) + '. Fitur ini butuh akses SSH (kunci di halaman Server).');
  const facts = parseFacts(r.stdout);
  await db().exec('UPDATE servers SET facts=$1::jsonb, facts_at=$2, os_info=CASE WHEN $3<>\'\' THEN $3 ELSE os_info END WHERE id=$4', [JSON.stringify(facts), Date.now(), [facts.os, facts.kernel].filter(Boolean).join(' | '), serverId]);
  await audit(by, 'dokumentasi.fakta', `server ${serverId}`);
  const known = new Set((await db().query('SELECT address FROM server_addresses WHERE server_id=$1', [serverId])).map((a) => a.address));
  const newIps = (facts.ips as string[]).map((x) => x.split(' ')[1]?.split('/')[0]).filter((x): x is string => !!x && !known.has(x));
  return { facts, suggestions: { addresses: newIps } };
}

// ---------- ekspor (tanpa rahasia)
const dt = (ms: number | null | undefined): string => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : '-');
export async function exportMarkdown(serverId: number): Promise<string> {
  const p = await getProfile(serverId), s = p.server as any, f = (s.facts ?? {}) as Record<string, any>;
  const creds = await db().query('SELECT label,kind,username,url,port,notes,rotated_at,rotate_every_days FROM credentials WHERE server_id=$1 ORDER BY label', [serverId]);
  const tasks = await db().query('SELECT title,category,every_days,due_at,last_done FROM maintenance_tasks WHERE server_id=$1 AND enabled ORDER BY due_at', [serverId]);
  const log = await db().query('SELECT title,done_at,done_by,notes FROM maintenance_log WHERE server_id=$1 ORDER BY done_at DESC LIMIT 15', [serverId]);
  const L: string[] = [`# ${s.name}`, '', `> Diekspor ${dt(Date.now())} dari AI Ops. **Tidak memuat password atau secret.**`, '', '## Ringkasan', '', `- **Fungsi:** ${s.purpose || '-'}`, `- **Lingkungan:** ${s.environment}`, `- **Pemilik / penanggung jawab:** ${s.owner || '-'}`, `- **Lokasi:** ${s.location || '-'}`, `- **Tag:** ${(s.tags as string[]).join(', ') || '-'}`, `- **OS:** ${s.os_info || f.os || '-'}`, `- **Akses SSH:** ${s.username}@${s.host}:${s.port}`, ''];
  if (p.addresses.length) { L.push('## Alamat', '', '| Label | Jenis | Alamat | Catatan |', '|---|---|---|---|'); for (const a of p.addresses as any[]) L.push(`| ${a.label || '-'}${a.is_primary ? ' (utama)' : ''} | ${a.kind} | \`${a.address}\` | ${a.notes || ''} |`); L.push(''); }
  if (p.services.length) { L.push('## Layanan', '', '| Layanan | Port | URL | Catatan |', '|---|---|---|---|'); for (const v of p.services as any[]) L.push(`| ${v.name} | ${v.port ? v.port + '/' + v.protocol : '-'} | ${v.url || ''} | ${v.notes || ''} |`); L.push(''); }
  if (p.depends.length || p.dependents.length) { L.push('## Ketergantungan', ''); for (const d of p.depends as any[]) L.push(`- Bergantung pada **${d.name}**${d.note ? ' (' + d.note + ')' : ''}`); for (const d of p.dependents as any[]) L.push(`- Dipakai oleh **${d.name}**${d.note ? ' (' + d.note + ')' : ''}`); L.push(''); }
  if (creds.length) { L.push('## Kredensial (hanya metadata)', '', '| Label | Jenis | Pengguna | URL/Port | Terakhir diganti | Rotasi |', '|---|---|---|---|---|---|'); for (const c of creds) L.push(`| ${c.label} | ${c.kind} | ${c.username || '-'} | ${c.url || ''}${c.port ? ':' + c.port : ''} | ${dt(c.rotated_at)} | ${c.rotate_every_days ? 'tiap ' + c.rotate_every_days + ' hari' : '-'} |`); L.push('', '_Password disimpan terenkripsi di vault AI Ops._', ''); }
  if (tasks.length) { L.push('## Jadwal pemeliharaan', '', '| Tugas | Kategori | Periode | Jatuh tempo | Terakhir |', '|---|---|---|---|---|'); for (const t of tasks) L.push(`| ${t.title} | ${t.category} | ${t.every_days ? t.every_days + ' hari' : 'sekali'} | ${dt(t.due_at)} | ${dt(t.last_done)} |`); L.push(''); }
  if (log.length) { L.push('## Riwayat pemeliharaan', ''); for (const l of log) L.push(`- ${dt(l.done_at)} **${l.title}**${l.done_by ? ' oleh ' + l.done_by : ''}${l.notes ? ': ' + l.notes : ''}`); L.push(''); }
  if (f.cpu_cores) L.push('## Fakta terakhir dari server', '', `- CPU: ${f.cpu_cores} core${f.cpu_model ? ' (' + f.cpu_model + ')' : ''}; RAM: ${f.ram_mb} MB; Disk /: ${f.disk_root || '-'}`, `- Kernel: ${f.kernel || '-'}; uptime ${f.uptime_d ?? '-'} hari; zona waktu ${f.timezone || '-'}`, `- Pembaruan tertunda: ${f.updates ?? '-'}; perlu reboot: ${f.reboot_required ? 'ya' : 'tidak'}`, `- Diambil: ${dt(s.facts_at)}`, '');
  if (s.runbook) L.push('## Catatan / Runbook', '', s.runbook, '');
  return L.join('\n');
}
/** Sel yang diawali = + @ tab atau - (selain angka dan penanda "-") dijalankan sebagai rumus oleh Excel/Sheets; os_info dan nama berasal dari server yang dikelola, jadi diawali apostrof. */
const csv = (v: unknown): string => { let t = String(v ?? ''); if (/^[=+@\t\r]/.test(t) || /^-(?![\d.,]+$)./.test(t)) t = "'" + t; return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
export async function exportCsv(): Promise<string> {
  const rows = await inventory({}), head = ['nama', 'alamat_utama', 'host_ssh', 'pengguna_ssh', 'fungsi', 'lingkungan', 'tag', 'pemilik', 'lokasi', 'os', 'jumlah_kredensial', 'pemeliharaan_berikutnya', 'terlambat'];
  return [head.join(','), ...rows.map((r) => [r.name, r.primary_address, r.host, r.username, r.purpose, r.environment, (r.tags as string[]).join(' '), r.owner, r.location, r.os_info, r.credentials, dt(r.next_due), r.overdue].map(csv).join(','))].join('\n');
}

// Inventaris server: data, validasi, dan uji koneksi SSH. Hanya kunci SSH; password tidak pernah disimpan.
// Kunci privat (opsional) disimpan terenkripsi; API tidak pernah mengembalikannya.
import { audit, bad, db } from './context.js';
import { createHash } from 'node:crypto';
import { open, seal } from './crypto.js';
import * as SSH from './ssh.js';

const state: { exec: SSH.ExecFn } = { exec: SSH.exec };
export function setExec(fn?: SSH.ExecFn): void { state.exec = fn ?? SSH.exec; }
export function run(server: SSH.SshTarget, cmd: string, opt?: { timeoutMs?: number }): Promise<SSH.ExecResult> { return state.exec(server, cmd, opt); }

export interface ServerRow { id: number; name: string; host: string; port: number; username: string; key_path: string; ssh_key_enc: string; ssh_pub: string; playground: boolean; exec_via: 'auto' | 'ssh' | 'agent'; use_sudo: boolean; services: string; notes: string; os_info: string; last_seen: number | null; last_status: string; created: number; open_alerts?: number }
export interface ServerInput { generate_key?: boolean; playground?: boolean; name?: string; host?: string; port?: number; username?: string; key_path?: string; ssh_key?: string; use_sudo?: boolean; services?: string; notes?: string; exec_via?: string }

const publicView = (s: ServerRow) => { const { ssh_key_enc, ...rest } = s; return { ...rest, has_ssh_key: !!ssh_key_enc }; };

function clean(b: ServerInput, old?: ServerRow) {
  const v = <K extends keyof ServerInput & keyof ServerRow>(k: K, d: unknown) => (b[k] !== undefined ? b[k] : old ? old[k] : d);
  const s = { name: String(v('name', '')).trim(), host: String(v('host', '')).trim(), port: Number(v('port', 22)), username: String(v('username', '')).trim(), key_path: String(v('key_path', '')).trim(),
    use_sudo: !!v('use_sudo', false), services: String(v('services', '')).split(/[,\s]+/).filter(Boolean).join(','), notes: String(v('notes', '')).slice(0, 1000), exec_via: String(v('exec_via', 'auto')) };
  if (!s.name || s.name.length > 60) throw bad('Nama wajib diisi (maks. 60 karakter)');
  if (!/^[A-Za-z0-9._-]+$/.test(s.host)) throw bad('Host hanya boleh huruf, angka, titik, minus, dan garis bawah');
  if (!(s.port >= 1 && s.port <= 65535)) throw bad('Port tidak valid');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(s.username)) throw bad('Nama pengguna SSH tidak valid');
  if (s.services && !s.services.split(',').every((x) => /^[A-Za-z0-9@._-]+$/.test(x))) throw bad('Nama layanan tidak valid');
  if (!['auto', 'ssh', 'agent'].includes(s.exec_via)) throw bad('exec_via harus auto, ssh, atau agent');
  return s;
}
function cleanKey(k: string): string {
  const t = k.replace(/\r\n/g, '\n').trim();
  if (t.length > 16_000 || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t) || !/-----END [A-Z ]*PRIVATE KEY-----$/.test(t)) throw bad('Kunci privat tidak valid. Tempel seluruh isi berkas kunci (mulai dari -----BEGIN ... PRIVATE KEY-----), tanpa passphrase.');
  return t;
}

/** Keadaan server menurut yang kita punya: bila ada agen yang pernah terhubung, dari agen (hidup atau mati) dan peringatan Major atau Critical yang terbuka;
 *  jika tidak, dari pemeriksaan manual terakhir. Tanpa pemantauan berkala, agen adalah sumber kondisi yang sebenarnya. */
async function withAgentState<T extends ServerRow | ReturnType<typeof publicView>>(rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const agents = new Map((await db().query<{ server_id: number; online: boolean; last_seen: number }>('SELECT server_id, online, last_seen FROM agents WHERE last_seen IS NOT NULL')).map((r) => [Number(r.server_id), r]));
  const urgent = new Set((await db().query<{ server_id: number }>("SELECT DISTINCT server_id FROM alerts WHERE NOT resolved AND level IN ('major','critical')")).map((r) => Number(r.server_id)));
  return rows.map((s) => { const a = agents.get(s.id); return a ? { ...s, last_seen: Math.max(s.last_seen ?? 0, Number(a.last_seen)), last_status: !a.online ? 'tidak terjangkau' : urgent.has(s.id) ? 'peringatan' : 'ok' } : s; });
}
export async function list() { return withAgentState((await db().query<ServerRow>('SELECT s.*, (SELECT COUNT(*) FROM alerts a WHERE a.server_id=s.id AND NOT a.resolved AND a.level<>\'info\')::int AS open_alerts FROM servers s ORDER BY s.name')).map(publicView)); }
export async function get(id: number | string): Promise<ServerRow | undefined> { return db().one<ServerRow>('SELECT * FROM servers WHERE id=$1', [Number(id)]); }
export async function getPublic(id: number | string) { const s = await get(id); return s ? (await withAgentState([publicView(s)]))[0] : undefined; }

export async function save(body: ServerInput, id?: number | string) {
  const old = id ? await get(id) : undefined; if (id && !old) throw bad('Server tidak ada');
  const s = clean(body, old);
  const generated = body.generate_key ? await SSH.generateKeypair(`aiops-${s.name.replace(/[^A-Za-z0-9._-]/g, "-")}`.slice(0, 60)) : null;
  const keyEnc = generated ? seal(generated.privateKey) : body.ssh_key ? seal(cleanKey(body.ssh_key)) : old ? old.ssh_key_enc : '';
  if (!keyEnc && !s.key_path) throw bad('Kunci SSH wajib: tempel kunci privat, atau isi path berkas kunci. Login dengan password tidak didukung.');
  try {
    if (old) await db().exec('UPDATE servers SET name=$1,host=$2,port=$3,username=$4,key_path=$5,ssh_key_enc=$6,use_sudo=$7,services=$8,notes=$9,exec_via=$10 WHERE id=$11', [s.name, s.host, s.port, s.username, s.key_path, keyEnc, s.use_sudo, s.services, s.notes, s.exec_via, old.id]);
    else await db().exec('INSERT INTO servers(name,host,port,username,key_path,ssh_key_enc,use_sudo,services,notes,exec_via,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [s.name, s.host, s.port, s.username, s.key_path, keyEnc, s.use_sudo, s.services, s.notes, s.exec_via, Date.now()]);
  } catch (e) { if ((e as { code?: string }).code === '23505') throw bad('Nama server sudah dipakai'); throw e; }
  if (body.playground !== undefined) await db().exec('UPDATE servers SET playground=$1 WHERE name=$2', [!!body.playground, s.name]);   // server uji: hanya yang ditandai boleh dipasangi susunan
  if (generated) await db().exec('UPDATE servers SET ssh_pub=$1 WHERE name=$2', [generated.publicKey, s.name]);
  else if (body.ssh_key) await db().exec("UPDATE servers SET ssh_pub='' WHERE name=$1", [s.name]);   // kunci ditempel pengguna: kunci publiknya tidak kita ketahui
  await audit('pengguna', old ? 'server.ubah' : 'server.tambah', `${s.name} ${s.username}@${s.host}${generated ? ' (kunci dibuat aplikasi)' : ''}`);
  return publicView((await db().one<ServerRow>('SELECT * FROM servers WHERE name=$1', [s.name]))!);
}
export async function remove(id: number | string): Promise<void> { const s = await get(id); if (s) { await db().exec('DELETE FROM servers WHERE id=$1', [s.id]); await audit('pengguna', 'server.hapus', s.name); } }

/** Saran untuk galat SSH yang umum, supaya pengguna tahu langkah berikutnya. Kosong bila tidak dikenali. */
export const fingerprintOf = (pub: string): string => { const blob = pub.trim().split(/\s+/)[1] ?? ''; return blob ? 'SHA256:' + createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '') : ''; };

export function explainSshError(stderr: string, username: string, fingerprint = ''): string {
  if (/Permission denied \(publickey/i.test(stderr)) return `${fingerprint ? `Kunci yang ditawarkan aplikasi: ${fingerprint}. Di server, jalankan: ssh-keygen -lf ~/.ssh/authorized_keys  (sebagai pengguna "${username}"). Bila sidik jari itu TIDAK ada di daftar, kunci belum terpasang di berkas yang benar. ` : ''}Server menolak kunci. Penyebab tersering: kunci publik belum ada di ~/.ssh/authorized_keys milik pengguna "${username}" (bukan pengguna lain), barisnya terpotong atau berganti baris, atau izin berkas salah (folder rumah tidak boleh bisa ditulis orang lain, .ssh harus 700, authorized_keys harus 600). Bandingkan dengan tombol "Kunci publik" di baris server, dan lihat penyebab pastinya di server: sudo journalctl -u ssh -n 30 --no-pager (atau sudo tail -n 20 /var/log/auth.log bila berkas itu ada). Langkah lengkap: Panduan bagian 3.`;
  if (/Connection refused/i.test(stderr)) return 'Port SSH ditolak: layanan SSH tidak berjalan di server itu atau port-nya bukan yang Anda isi.';
  if (/timed out|No route to host|Network is unreachable/i.test(stderr)) return 'Server tidak terjangkau dari aplikasi: periksa alamat, firewall, dan apakah alamat itu hanya ada di jaringan/VPN yang tidak terlihat dari Docker.';
  if (/Could not resolve hostname/i.test(stderr)) return 'Nama host tidak dikenali. Periksa ejaan atau pakai alamat IP.';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) return 'Sidik jari server berubah (server dipasang ulang atau ada pihak lain di tengah). Pastikan penyebabnya sebelum menghapus catatan known_hosts aplikasi.';
  if (/Load key .*(invalid format|error in libcrypto)/i.test(stderr)) return 'Kunci privat yang tersimpan tidak terbaca. Isi ulang kunci di formulir Server, atau pakai Buat kunci otomatis.';
  return '';
}

const PROBE = `uname -srm; grep -m1 PRETTY_NAME /etc/os-release 2>/dev/null; echo "cpu=$(nproc 2>/dev/null)"; awk '/MemTotal/{printf "ram_mb=%d\\n", $2/1024}' /proc/meminfo 2>/dev/null; uptime -p 2>/dev/null; exit 0`;   // exit 0: gagalnya satu perintah info (mis. uptime -p di busybox) bukan berarti koneksi putus
export async function test(id: number | string): Promise<{ ok: boolean; info?: string; error?: string; hint?: string; ms?: number }> {
  const s = await get(id); if (!s) throw bad('Server tidak ada');
  const r = await run(s, PROBE, { timeoutMs: 20_000 });
  if (r.exitCode !== 0) { await db().exec('UPDATE servers SET last_status=$1 WHERE id=$2', ['tidak terjangkau', s.id]); return { ok: false, error: (r.stderr || 'Koneksi gagal').trim().split('\n').slice(-2).join(' ').slice(0, 300), hint: explainSshError(r.stderr, s.username, s.ssh_pub ? fingerprintOf(s.ssh_pub) : s.ssh_key_enc ? await SSH.fingerprintOfPrivate(open(s.ssh_key_enc)) : '') }; }
  const info = r.stdout.trim().split('\n').map((l) => l.replace(/^PRETTY_NAME=/, '').replace(/^"|"$/g, '')).join(' | ').slice(0, 400);
  await db().exec('UPDATE servers SET os_info=$1, last_seen=$2, last_status=$3 WHERE id=$4', [info, Date.now(), 'ok', s.id]); await audit('pengguna', 'server.uji', s.name);
  return { ok: true, info, ms: r.ms };
}

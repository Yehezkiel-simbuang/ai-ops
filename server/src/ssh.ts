// Menjalankan perintah di server lewat OpenSSH (tanpa library, tanpa password). Kunci privat dari database dituliskan ke berkas sementara 0600
// hanya selama perintah berjalan. known_hosts disimpan permanen di DATA_DIR/ssh (host key baru diterima sekali, lalu harus cocok).
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ctx } from './context.js';
import { open } from './crypto.js';

/** Membuat pasangan kunci ed25519 tanpa passphrase lewat ssh-keygen (format OpenSSH, dipakai ssh apa adanya). Berkas sementara dihapus segera. */
export async function generateKeypair(label = 'aiops'): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-gen-')), file = join(dir, 'k');
  try {
    await new Promise<void>((resolveP, reject) => {
      const child = spawn(ctx().cfg.SSH_KEYGEN_BIN, ['-q', '-t', 'ed25519', '-N', '', '-C', label, '-f', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => reject(new Error(`ssh-keygen tidak bisa dijalankan: ${e.message}`)));
      child.on('close', (code) => (code === 0 ? resolveP() : reject(new Error(`ssh-keygen gagal: ${err.trim().slice(0, 200)}`))));
    });
    return { privateKey: (await readFile(file, 'utf8')).trim(), publicKey: (await readFile(`${file}.pub`, 'utf8')).trim() };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Sidik jari SHA256 dari kunci privat (bentuk yang sama dengan `ssh-keygen -lf` di server). Kosong bila tak terbaca. */
export async function fingerprintOfPrivate(pem: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-fp-')), file = join(dir, 'k');
  try {
    await writeFile(file, pem.endsWith('\n') ? pem : pem + '\n', { mode: 0o600 }); await chmod(file, 0o600);
    return await new Promise<string>((resolveP) => {
      const child = spawn(ctx().cfg.SSH_KEYGEN_BIN, ['-lf', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = ''; child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => resolveP('')); child.on('close', () => resolveP(/SHA256:\S+/.exec(out)?.[0] ?? ''));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export const MAX_OUT = 12_000;
export function clip(s: unknown): string { const t = String(s ?? ''); return t.length <= MAX_OUT ? t : `${t.slice(0, MAX_OUT / 2)}\n... [dipotong ${t.length - MAX_OUT} karakter] ...\n${t.slice(-MAX_OUT / 2)}`; }
export interface SshTarget { host: string; port: number; username: string; key_path?: string; ssh_key_enc?: string; use_sudo?: boolean }
export interface ExecResult { exitCode: number; stdout: string; stderr: string; ms: number; timedOut: boolean }
export type ExecFn = (server: SshTarget, command: string, opt?: { timeoutMs?: number }) => Promise<ExecResult>;

const expandHome = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// batas proses ssh paralel supaya satu lonjakan pemeriksaan tidak menghabiskan proses/memori
const MAX_PARALLEL = 8; let running = 0; const waiters: Array<() => void> = [];
async function slot(): Promise<() => void> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r));
  running++; return () => { running--; waiters.shift()?.(); };
}

function validate(s: SshTarget): void {
  if (!/^[A-Za-z0-9._-]+$/.test(s.host || '')) throw new Error('Host tidak valid');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(s.username || '')) throw new Error('Pengguna tidak valid');
  const kp = s.key_path ? expandHome(s.key_path) : ''; if (kp && !existsSync(kp)) throw new Error(`Berkas kunci SSH tidak ditemukan: ${kp}`);
}

export const exec: ExecFn = async (server, command, opt = {}) => {
  const release = await slot(), t0 = Date.now(); let tmp: string | null = null;
  try {
    validate(server);
    if (!server.ssh_key_enc && !server.key_path) throw new Error('Kunci SSH belum diisi untuk server ini. Hanya login dengan kunci yang didukung; ubah server dan isi kunci privatnya.');
    const { cfg } = ctx(), dir = resolve(cfg.DATA_DIR, 'ssh'); await mkdir(dir, { recursive: true, mode: 0o700 });
    const args = ['-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`, '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', '-p', String(server.port || 22)];
    // Kunci tersimpan didahulukan; bila tidak ada, isi berkas di key_path disalin ke berkas sementara 0600 (ssh menolak kunci yang izinnya terbuka, mis. berkas rahasia Docker 0777)
    const pem = server.ssh_key_enc ? open(server.ssh_key_enc) : server.key_path ? await readFile(expandHome(server.key_path), 'utf8') : '';
    if (pem) { tmp = await mkdtemp(join(tmpdir(), 'aiops-k-')); const f = join(tmp, 'id'); await writeFile(f, pem.endsWith('\n') ? pem : pem + '\n', { mode: 0o600 }); await chmod(f, 0o600); args.push('-i', f, '-o', 'IdentitiesOnly=yes'); }
    args.push(`${server.username}@${server.host}`, command);
    return await new Promise<ExecResult>((resolveP) => {
      let out = '', err = '', done = false, timedOut = false;
      const child = spawn(cfg.SSH_BIN, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opt.timeoutMs ?? 30_000);
      child.stdout.on('data', (d) => { if (out.length < MAX_OUT * 4) out += d; });
      child.stderr.on('data', (d) => { if (err.length < MAX_OUT * 4) err += d; });
      const fin = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolveP({ exitCode: timedOut ? 124 : (code ?? 255), stdout: clip(out), stderr: clip(err + (timedOut ? '\n[waktu habis]' : '')), ms: Date.now() - t0, timedOut }); };
      child.on('error', (e) => { err += e.message; fin(255); });
      child.on('close', fin);
    });
  } catch (e) { return { exitCode: 255, stdout: '', stderr: (e as Error).message, ms: Date.now() - t0, timedOut: false }; }
  finally { if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined); release(); }
};

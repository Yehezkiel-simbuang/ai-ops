import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeKeyId, initCrypto, needsRotation, open, seal, setOpenFailureHandler } from '../src/crypto.js';
import { redactOutput } from '../src/redact.js';
import * as Agents from '../src/agents.js';
import * as Auth from '../src/auth.js';
import { rotateAll } from '../src/rotate.js';
import { harness, login, ADMIN_PW, type Harness } from './helpers.js';

const KA = 'a'.repeat(64), KB = 'b'.repeat(64);

describe('cincin kunci', () => {
  it('seal memakai format v2 dengan id kunci aktif', () => {
    initCrypto(KA); const s = seal('rahasia'); expect(s.startsWith(`v2:${activeKeyId()}:`)).toBe(true); expect(open(s)).toBe('rahasia'); expect(needsRotation(s)).toBe(false);
  });
  it('format v1 lama tetap terbuka dan ditandai perlu rotasi', () => {
    initCrypto(KA); const s = seal('lama'), [, , iv, tag, data] = s.split(':'), v1 = `v1:${iv}:${tag}:${data}`;
    expect(open(v1)).toBe('lama'); expect(needsRotation(v1)).toBe(true);
  });
  it('kunci lama di MASTER_KEY_PREVIOUS masih membuka data lama; tanpa itu gagal dan dilaporkan', () => {
    initCrypto(KA); const old = seal('x');
    const fails: string[] = []; setOpenFailureHandler((w) => fails.push(w));
    initCrypto(KB); expect(open(old)).toBe(''); expect(fails.length).toBe(1); expect(fails[0]).toMatch(/cincin kunci/);
    initCrypto(KB, [KA]); expect(open(old)).toBe('x'); expect(needsRotation(old)).toBe(true); expect(open(seal('baru'))).toBe('baru');
    setOpenFailureHandler(() => undefined);
  });
  it('data yang diubah dilaporkan sebagai rusak', () => {
    initCrypto(KA); const fails: string[] = []; setOpenFailureHandler((w) => fails.push(w));
    const s = seal('x'); expect(open(s.slice(0, -4) + 'AAAA')).toBe(''); expect(fails[0]).toMatch(/rusak/); setOpenFailureHandler(() => undefined);
  });
  it('id kunci bukan rahasia: turunan hash, 8 heks', () => { initCrypto(KA); expect(activeKeyId()).toBe(createHash('sha256').update(Buffer.from(KA, 'hex')).digest('hex').slice(0, 8)); });
});

describe('penyamaran keluaran', () => {
  it.each([
    ['DB_PASSWORD=hunter2', 'DB_PASSWORD=***'],
    ['mysql_root_password: "s3cr3t!"', 'mysql_root_password: ***'],
    ['{"api_key": "abc123xyz"}', '{"api_key": ***}'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'AWS_SECRET_ACCESS_KEY=***'],
    ['postgres://app:kata-rahasia@db:5432/x', 'postgres://app:***@db:5432/x'],
    ['Authorization: Bearer abcdef1234567890', 'Authorization: *** ***'],
    ['mysql -u root -pRahasia123 -e "show databases"', 'mysql -u root -p*** -e "show databases"'],
    ['curl --password=xyz https://x', 'curl --password=*** https://x'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok', 'token *** ok']
  ])('%s', (input, want) => expect(redactOutput(input)).toBe(want));
  it('kunci privat PEM diganti utuh', () => {
    const out = redactOutput('a\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\nxyz\n-----END OPENSSH PRIVATE KEY-----\nb');
    expect(out).not.toContain('AAAAB3Nza'); expect(out.startsWith('a\n')).toBe(true); expect(out.endsWith('\nb')).toBe(true);
  });
  it('keluaran biasa tidak berubah dan penyamaran idempoten', () => {
    const t = 'nginx.service - active (running)\nLoad: 0.12 0.10 0.05\nport 5432 listening'; expect(redactOutput(t)).toBe(t);
    const once = redactOutput('PASSWORD=abc'); expect(redactOutput(once)).toBe(once); expect(redactOutput(null)).toBe('');
  });
});

describe('basis data: kunci akun, anti-replay, rotasi, integritas', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); await login(h); });
  afterAll(async () => { await h.close(); });

  it('akun terkunci setelah 5 kegagalan, password benar pun ditolak, lalu terbuka lagi setelah masa kunci', async () => {
    const bad = () => h.call('POST', '/api/login', { username: h.cfg.ADMIN_USERNAME, password: 'salah-salah' }, { cookie: null });
    for (let i = 0; i < Auth.MAX_FAILS; i++) expect((await bad()).status).toBe(401);
    const row = await h.db.one('SELECT failed_logins, locked_until FROM users WHERE username=$1', [h.cfg.ADMIN_USERNAME]);
    expect(Number(row!.locked_until)).toBeGreaterThan(Date.now()); expect(row!.failed_logins).toBe(0);
    expect((await h.call('POST', '/api/login', { username: h.cfg.ADMIN_USERNAME, password: ADMIN_PW }, { cookie: null })).status).toBe(401);
    expect(await h.db.one("SELECT 1 AS x FROM audit WHERE action='akun.terkunci'")).toBeTruthy();
    await h.db.exec('UPDATE users SET locked_until=$1', [Date.now() - 1]);
    expect((await h.call('POST', '/api/login', { username: h.cfg.ADMIN_USERNAME, password: ADMIN_PW }, { cookie: null })).status).toBe(200);
    expect((await h.db.one('SELECT failed_logins, locked_until FROM users'))!.locked_until).toBeNull();
  });

  it('claimRequest menolak tanda tangan yang sama dua kali', async () => {
    const sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-replay', host: '10.9.9.9', username: 'ops' })).json.id;
    expect(await Agents.claimRequest(sid, 'sig-1')).toBe(true); expect(await Agents.claimRequest(sid, 'sig-1')).toBe(false); expect(await Agents.claimRequest(sid, 'sig-2')).toBe(true);
  });

  it('rotateAll mengenkripsi ulang ke kunci aktif dan nilai yang tidak terbaca tidak ditimpa', async () => {
    const cr = await h.call('POST', '/api/vault', { label: 'uji-rotasi', kind: 'password', secret: 'rahasia-asli' });
    const id = (cr.json.credential ?? cr.json).id;
    const before = (await h.db.one('SELECT secret_enc FROM credentials WHERE id=$1', [id]))!.secret_enc as string;
    initCrypto(KB, [h.cfg.MASTER_KEY]);   // ganti kunci aktif, kunci lama dipertahankan di cincin
    expect(needsRotation(before)).toBe(true);
    const rep = await rotateAll(); expect(rep.rotated).toBeGreaterThan(0); expect(rep.unreadable).toEqual([]);
    const after = (await h.db.one('SELECT secret_enc FROM credentials WHERE id=$1', [id]))!.secret_enc as string;
    expect(after).not.toBe(before); expect(needsRotation(after)).toBe(false); expect(open(after)).toBe('rahasia-asli');
    await h.db.exec("UPDATE credentials SET secret_enc='v2:deadbeef:aa:bb:cc' WHERE id=$1", [id]);
    const rep2 = await rotateAll(); expect(rep2.unreadable.some((u) => u.table === 'credentials')).toBe(true);
    expect((await h.db.one('SELECT secret_enc FROM credentials WHERE id=$1', [id]))!.secret_enc).toBe('v2:deadbeef:aa:bb:cc');
    initCrypto(h.cfg.MASTER_KEY, h.cfg.masterKeyPrevious);
  });

  it('FK baru: hapus server mengosongkan commands.server_id; CHECK rekomendasi menolak insiden tanpa incident_id', async () => {
    const sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-fk', host: '10.8.8.8', username: 'ops' })).json.id;
    const c = await h.db.one("INSERT INTO commands(server_id,ts,command,class,status) VALUES($1,$2,'uptime','read','done') RETURNING id", [sid, Date.now()]);
    await h.db.exec('DELETE FROM servers WHERE id=$1', [sid]);
    expect((await h.db.one('SELECT server_id FROM commands WHERE id=$1', [c!.id]))!.server_id).toBeNull();
    await expect(h.db.exec("INSERT INTO commands(server_id,ts,command,class,status) VALUES(999999,$1,'x','read','done')", [Date.now()])).rejects.toThrow(/foreign key/i);
    const s2 = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'srv-fk2', host: '10.8.8.9', username: 'ops' })).json.id;
    await expect(h.db.exec("INSERT INTO recommendations(incident_id,server_id,created,updated,kind) VALUES(NULL,$1,1,1,'incident')", [s2])).rejects.toThrow(/check/i);
    await h.db.exec("INSERT INTO recommendations(incident_id,server_id,created,updated,kind) VALUES(NULL,$1,1,1,'patch')", [s2]);
  });
});

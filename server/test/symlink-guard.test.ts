// Symlink di folder proyek tidak boleh diikuti: repo berbahaya bisa menautkan package.json ke /run/secrets/master_key sehingga isinya ikut ke prompt model.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFiles } from '../src/lab/estimate.js';

const require = createRequire(import.meta.url);
const scan = require(join(import.meta.dirname, '..', '..', 'simulator', 'tools', 'analyze', 'scan.js')) as { read: (p: string) => string; walk: (d: string, exts: string[]) => string[] };
const KUNCI = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** Proyek contoh: package.json asli, ditambah tautan ke rahasia (berkas dan folder). Mengembalikan null bila mesin ini tidak mengizinkan symlink. */
function fixture(): { proj: string; secret: string } | null {
  const proj = mkdtempSync(join(tmpdir(), 'sl-proj-')), out = mkdtempSync(join(tmpdir(), 'sl-out-')), secret = join(out, 'master_key');
  writeFileSync(secret, KUNCI); writeFileSync(join(proj, 'package.json'), '{"name":"asli","dependencies":{"express":"4"}}');
  mkdirSync(join(out, 'folder')); writeFileSync(join(out, 'folder', 'package.json'), `{"rahasia":"${KUNCI}"}`);
  try {
    symlinkSync(secret, join(proj, 'docker-compose.yml'), 'file'); symlinkSync(secret, join(proj, '.env.example'), 'file');
    symlinkSync(join(out, 'folder'), join(proj, 'tertaut'), 'dir');
  } catch { return null; }
  return { proj, secret };
}

describe('symlink tidak diikuti', () => {
  it('estimasi AI: hanya berkas asli yang dikumpulkan; isi rahasia tidak ada di baris mana pun', (ctx) => {
    const f = fixture(); if (!f) { ctx.skip(); return; }
    const files = collectFiles(f.proj);
    expect(files.map((x) => x.file)).toEqual(['package.json']); expect(JSON.stringify(files)).not.toContain(KUNCI);
  });
  it('penganalisis simulator: read menolak symlink dan walk tidak mendaftarkannya, tetapi berkas asli tetap terbaca', (ctx) => {
    const f = fixture(); if (!f) { ctx.skip(); return; }
    expect(scan.read(join(f.proj, 'docker-compose.yml'))).toBe(''); expect(scan.read(join(f.proj, '.env.example'))).toBe(''); expect(scan.read(join(f.proj, 'package.json'))).toContain('"asli"');
    const listed = scan.walk(f.proj, ['.json', '.yml']).map((p) => p.replace(/\\/g, '/').split('/').pop());
    expect(listed).toEqual(['package.json']);   // 'tertaut/package.json' dan docker-compose.yml (symlink) tidak ikut
  });
});

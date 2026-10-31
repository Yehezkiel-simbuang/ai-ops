// Panduan insiden Redis: crash-loop karena AOF rusak. Rencana hanya membaca dan mencadangkan; memotong AOF tidak pernah otomatis.
import { describe, expect, it } from 'vitest';
import { playbook, redisPlan } from '../src/incidents.js';
import { classify } from '../src/safety.js';

const inc = (unit: string) => ({ key: `svc:${unit}`, kind: 'service', title: `Layanan ${unit} tidak aktif`, detail: 'status: activating' });

describe('playbook Redis', () => {
  it('insiden layanan redis memakai rencana khusus; layanan lain tetap memakai rencana umum', () => {
    expect(playbook(inc('redis-server'), { use_sudo: false }).diagnosis).toMatch(/crash-loop/);
    expect(playbook(inc('redis'), { use_sudo: false }).diagnosis).toMatch(/Bad file format reading the append only file/);
    expect(playbook(inc('nginx'), { use_sudo: false }).diagnosis).not.toMatch(/AOF/);
    expect(playbook(inc('redis-sentinel'), { use_sudo: false }).diagnosis).not.toMatch(/crash-loop/);   // hanya unit data Redis
  });

  it('langkah baca benar-benar dikelompokkan sebagai baca, langkah yang mengubah sebagai ubah, dan --fix tidak pernah ada di rencana', () => {
    for (const sudo of ['', 'sudo -n ']) {
      const plan = redisPlan('redis-server', sudo);
      for (const s of plan.steps) {
        const cls = classify(s.command).cls;
        expect(cls, s.title).not.toBe('blocked');
        expect(cls === 'read', `${s.title}: ${s.command}`).toBe(s.risk === 'rendah');
        expect(s.command).not.toMatch(/--fix|--truncate-to-timestamp|appendonlydir\/?\s*$|rm\s|flush/i);
      }
      expect(plan.steps.filter((s) => s.risk === 'rendah').length).toBeGreaterThanOrEqual(6);
    }
  });

  it('urutan aman: baca bukti dulu, hentikan, cadangkan, baru jalankan ulang; ada pemeriksaan AOF tanpa --fix', () => {
    const t = redisPlan('redis-server', '').steps.map((s) => s.title), cmds = redisPlan('redis-server', '').steps.map((s) => s.command);
    expect(cmds.some((c) => /^redis-check-aof \S+\.manifest$/.test(c))).toBe(true);
    const iCheck = cmds.findIndex((c) => c.startsWith('redis-check-aof')), iStop = cmds.findIndex((c) => /systemctl stop/.test(c)), iCopy = cmds.findIndex((c) => /^cp -a /.test(c)), iRestart = cmds.findIndex((c) => /systemctl restart/.test(c));
    expect(iCheck).toBeGreaterThanOrEqual(0); expect(iCheck).toBeLessThan(iStop); expect(iStop).toBeLessThan(iCopy); expect(iCopy).toBeLessThan(iRestart);
    expect(t[t.length - 1]).toMatch(/Jalankan ulang/); expect(redisPlan('redis-server', '').steps.find((s) => /Jalankan ulang/.test(s.title))!.risk).toBe('tinggi');
  });

  it('nama unit dimasukkan apa adanya ke perintah, jadi hanya nama unit yang aman yang sampai ke playbook', () => {
    expect(playbook({ key: 'svc:redis-server; rm -rf x', kind: 'service', title: 't', detail: 'd' }, { use_sudo: false }).diagnosis).not.toMatch(/crash-loop/);
  });
});

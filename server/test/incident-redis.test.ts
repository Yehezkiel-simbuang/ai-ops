// Alur penuh: agen melaporkan unit Redis tidak aktif -> insiden -> rekomendasi khusus Redis (bukti dulu, cadangan, tanpa --fix).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Agents from '../src/agents.js';
import { agentTs, harness, login, until, type Harness } from './helpers.js';

let h: Harness, sid = 0, keyId = '', secret = '';
beforeAll(async () => {
  h = await harness(); await login(h);
  sid = (await h.call('POST', '/api/servers', { key_path: '/k', name: 'marine-03', host: '10.7.7.7', username: 'ops', use_sudo: true })).json.id;
  const r = await h.call('POST', `/api/servers/${sid}/agent`, { exec: true }); keyId = r.json.keyId; secret = r.json.config.secret;
});
afterAll(async () => { await h.close(); });

async function agentPost(path: string, body: unknown) {
  const raw = JSON.stringify(body), ts = agentTs();
  const r = await h.app.inject({ method: 'POST', url: path, headers: { host: 'localhost', 'content-type': 'application/json', 'x-aiops-key': keyId, 'x-aiops-ts': ts, 'x-aiops-sig': Agents.signRequest(secret, ts, 'POST', path, raw) }, payload: raw });
  return { status: r.statusCode, json: r.json() };
}

describe('insiden Redis dari agen', () => {
  it('unit redis-server yang terus activating menghasilkan insiden dan rekomendasi khusus Redis', async () => {
    const e = { id: 'redis-1', type: 'open', key: 'svc:redis-server', title: 'Layanan redis-server tidak aktif', kind: 'service', severity: 'critical', detail: 'status: activating', ts: Math.floor(Date.now() / 1000),
      diag: [{ name: 'systemctl status', out: 'Active: activating (start) ... Status: "Redis is loading..."' }] };
    expect((await agentPost('/agent/v1/events', { events: [e] })).json).toMatchObject({ ok: true, accepted: 1 });
    const list = (await h.call('GET', '/api/incidents?status=open')).json as any[]; expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ key: 'svc:redis-server', server_name: 'marine-03' });
    expect(await until(async () => ((await h.call('GET', '/api/incidents?status=open')).json as any[])[0].rec_status === 'proposed')).toBeTruthy();
    const rec = (await h.call('GET', `/api/incidents/${list[0].id}`)).json.recommendations[0];
    expect(rec.source).toBe('playbook'); expect(rec.diagnosis).toMatch(/AOF/); expect(rec.diagnosis).toMatch(/Bad file format/);
    const cmds: string[] = rec.steps.map((s: any) => s.command), byCmd = (re: RegExp) => rec.steps.find((s: any) => re.test(s.command));
    expect(byCmd(/redis-check-aof .*\.manifest$/).class).toBe('read');   // baca saja: langsung bisa dijalankan
    expect(byCmd(/tail -n 80 \/var\/log\/redis\/redis-server\.log/).class).toBe('read');
    expect(byCmd(/systemctl stop redis-server/).class).toBe('change'); expect(byCmd(/cp -a \/var\/lib\/redis/).class).toBe('change');
    expect(cmds.every((c) => !/--fix|--truncate-to-timestamp/.test(c))).toBe(true);   // memotong AOF tidak pernah otomatis
    expect(rec.steps.some((s: any) => s.class === 'blocked')).toBe(false); expect(cmds.every((c) => c.startsWith('sudo -n '))).toBe(true);   // server memakai sudo
  });
});

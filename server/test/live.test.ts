// Data untuk diagram langsung selama uji berjalan: pemakaian sampel terbaru tiap komponen dan tahap yang sedang berjalan. Semua dari sampel nyata.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveUsage, replayFrames, type Sample } from '../src/loadtest/bottleneck.js';
import { architecture, type SvcIn } from '../src/loadtest/roles.js';
import { harness, login, type Harness } from './helpers.js';

const services: SvcIn[] = [{ name: 'web', image: 'nginx:1.27', published: true }, { name: 'api', image: 'x/api:1' }, { name: 'db', image: 'postgres:17' }];
const arch = architecture(services);
const T = 5_000_000;
const sm = (ts: number, service: string, cpu: number, mem_mb = 200, mem_limit_mb = 0, cores = 0): Sample => ({ ts, service, cpu, mem_mb, mem_limit_mb, cores });
const plan = [{ vus: 5 }, { vus: 20 }, { vus: 80 }];

describe('liveUsage', () => {
  it('tanpa sampel: null', () => { expect(liveUsage([], plan, 0, arch, {})).toBeNull(); });

  it('memakai hanya sampel terbaru; CPU dinormalkan terhadap core server (100 = satu core) dan memori terhadap total server', () => {
    const rows = [
      sm(T, 'api', 20), sm(T, 'db', 10), sm(T, '_host', 0.4, 600, 4000, 2),
      sm(T + 5000, 'api', 150), sm(T + 5000, 'db', 40, 800), sm(T + 5000, '_host', 1.6, 1800, 4000, 2)
    ];
    const l = liveUsage(rows, plan, 1, arch, {})!;
    expect(l.at).toBe(T + 5000); expect(l.stageIdx).toBe(1); expect(l.vus).toBe(20); expect(l.maxVus).toBe(80);
    const api = l.services.find((s) => s.service === 'api')!, db = l.services.find((s) => s.service === 'db')!;
    expect(api).toMatchObject({ role: 'app', cpuCores: 1.5 }); expect(api.cpu).toBeCloseTo(0.75, 5);   // 150% = 1,5 core dari 2 core
    expect(db.role).toBe('db'); expect(db.cpu).toBeCloseTo(0.2, 5); expect(db.mem).toBeCloseTo(0.2, 5);   // 800 dari 4000 MB
    expect(l.host).toMatchObject({ cores: 2, load: 1.6 }); expect(l.host!.cpu).toBeCloseTo(0.8, 5); expect(l.host!.mem).toBeCloseTo(0.45, 5);
    expect(l.services.some((s) => s.service === '_host')).toBe(false);   // server uji dilaporkan terpisah, bukan sebagai layanan
  });

  it('batas layanan dipakai bila ada: 50% dari batas 0,5 core = 100%', () => {
    const l = liveUsage([sm(T, 'db', 50), sm(T, '_host', 0.2, 500, 4000, 2)], plan, 0, arch, { db: { cpus: 0.5, memMb: 400 } })!;
    expect(l.services[0]!.cpu).toBeCloseTo(1, 5); expect(l.services[0]!.mem).toBeCloseTo(0.5, 5);   // 200 MB dari batas 400 MB
  });

  it('tanpa sampel server (hanya kontainer): CPU dibagi satu core, memori tidak diketahui; setelah tahap terakhir vus null', () => {
    const l = liveUsage([sm(T, 'api', 80)], plan, 3, arch, {})!;
    expect(l.host).toBeNull(); expect(l.services[0]!.cpu).toBeCloseTo(0.8, 5); expect(l.services[0]!.mem).toBeNull(); expect(l.vus).toBeNull(); expect(l.stageIdx).toBe(3);
  });
});

describe('replayFrames', () => {
  const windows = [{ started: T, ended: T + 30_000 }, { started: T + 40_000, ended: T + 70_000 }, { started: T + 80_000, ended: T + 110_000 }];
  const at = (sec: number, cpu: number) => [sm(T + sec * 1000, 'api', cpu), sm(T + sec * 1000, '_host', 0.5, 500, 4000, 2)];

  it('satu bingkai per waktu sampel, berurutan, dengan tahap dan pengguna virtual menurut jendela waktu', () => {
    const rows = [...at(10, 20), ...at(5, 10), ...at(50, 60), ...at(100, 90)];   // sengaja tidak berurutan
    const f = replayFrames(rows, windows, plan, arch, {});
    expect(f.map((x) => x.at)).toEqual([T + 5000, T + 10_000, T + 50_000, T + 100_000]);
    expect(f.map((x) => x.stageIdx)).toEqual([0, 0, 1, 2]); expect(f.map((x) => x.vus)).toEqual([5, 5, 20, 80]);
    expect(f[3]!.services[0]!.cpu).toBeCloseTo(0.45, 5);   // 90% = 0,9 core dari 2 core
  });

  it('sampel di sela tahap dihitung ke tahap berikutnya, sebelum tahap pertama ke tahap pertama, sesudah tahap terakhir ke tahap terakhir', () => {
    const f = replayFrames([...at(-5, 1), ...at(35, 1), ...at(120, 1)], windows, plan, arch, {});
    expect(f.map((x) => x.stageIdx)).toEqual([0, 1, 2]);
  });

  it('dijarangkan merata bila melebihi batas, dengan bingkai pertama dan terakhir tetap ada', () => {
    const rows = Array.from({ length: 100 }, (_, i) => at(i, i)).flat(), f = replayFrames(rows, windows, plan, arch, {}, 10);
    expect(f).toHaveLength(10); expect(f[0]!.at).toBe(T); expect(f[9]!.at).toBe(T + 99_000); expect(f.map((x) => x.at)).toEqual([...f.map((x) => x.at)].sort((a, b) => a - b));
  });

  it('tanpa sampel atau tanpa rencana: kosong', () => {
    expect(replayFrames([], windows, plan, arch, {})).toEqual([]); expect(replayFrames(at(1, 1), windows, [], arch, {})).toEqual([]);
  });
});

describe('detail uji berjalan membawa data langsung', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); await login(h); });
  afterAll(async () => { await h.close(); });

  const insert = async (status: string) => (await h.db.one(
    `INSERT INTO load_tests(name,target,scenario,stages,criteria,status,created,started,setup) VALUES($1,'http://10.0.0.5:8080',$2,$3,$4,$5,$6,$6,$7) RETURNING id`,
    [`uji-${status}`, JSON.stringify({ requests: [{ name: 'a', method: 'GET', path: '/', weight: 1 }], thinkSeconds: 1, headerNames: [] }), JSON.stringify(plan.map((p) => ({ ...p, seconds: 30 }))), JSON.stringify({ p95Ms: 500, errPct: 1 }), status, Date.now(), JSON.stringify({ name: 'susunan', services })]))!.id as number;
  const sample = (id: number, ts: number, service: string, cpu: number, extra: [number, number, number] = [200, 0, 0]) =>
    h.db.exec('INSERT INTO load_samples(test_id,ts,service,cpu,mem_mb,mem_limit_mb,cores) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, ts, service, cpu, ...extra]);

  it('uji berjalan: live berisi sampel terbaru, tahap berjalan, dan pengguna virtualnya; arsitektur ikut', async () => {
    const id = await insert('running'), now = Date.now();
    await sample(id, now - 10_000, 'api', 10); await sample(id, now - 5_000, 'api', 90); await sample(id, now - 5_000, 'db', 30); await sample(id, now - 5_000, '_host', 1, [1000, 4000, 2]);
    const d = (await h.call('GET', `/api/loadtests/${id}`)).json;
    expect(d.architecture.nodes.map((n: any) => n.name)).toEqual(expect.arrayContaining(['web', 'api', 'db']));
    expect(d.live).toMatchObject({ at: now - 5_000, stageIdx: 0, vus: 5, maxVus: 80, host: { cores: 2 } });
    expect(d.live.services.find((s: any) => s.service === 'api').cpuCores).toBeCloseTo(0.9, 5); expect(d.live.services).toHaveLength(2);
  });

  it('uji selesai: replay berisi bingkai dari sampel tersimpan dan jendela tahap; live null; uji berjalan: replay null', async () => {
    const id = await insert('done'), t0 = Date.now() - 100_000;
    for (const [idx, vus] of [[0, 5], [1, 20], [2, 80]] as const) await h.db.exec(
      'INSERT INTO load_stages(test_id,idx,vus,seconds,reqs,rps,p50,p95,p99,err_pct,gen_cpu,valid,scraped,started,ended) VALUES($1,$2,$3,30,100,10,10,50,80,0,0.1,true,$4,$5,$6)', [id, idx, vus, '{}', t0 + idx * 35_000, t0 + idx * 35_000 + 30_000]);
    for (const sec of [5, 40, 75]) { await sample(id, t0 + sec * 1000, 'api', sec); await sample(id, t0 + sec * 1000, '_host', 1, [1000, 4000, 2]); }
    const d = (await h.call('GET', `/api/loadtests/${id}`)).json;
    expect(d.live).toBeNull(); expect(d.replay).toHaveLength(3);
    expect(d.replay.map((f: any) => [f.stageIdx, f.vus])).toEqual([[0, 5], [1, 20], [2, 80]]); expect(d.replay[2].services[0].service).toBe('api');
    const run = await insert('running'); await sample(run, Date.now(), 'api', 5);
    expect((await h.call('GET', `/api/loadtests/${run}`)).json.replay).toBeNull();
  });

  it('uji berjalan tanpa sampel, dan uji yang sudah selesai: live null', async () => {
    const run = await insert('running'); expect((await h.call('GET', `/api/loadtests/${run}`)).json.live).toBeNull();
    const done = await insert('done'); await sample(done, Date.now(), 'api', 50);
    expect((await h.call('GET', `/api/loadtests/${done}`)).json.live).toBeNull();
  });
});

import { componentKey, componentAction, initialScenario, peakRps, recAction, scenarioReducer, totalRps, actionKeyOf } from './scenario';
import { project, load } from './fixtures';
import type { Scenario } from './types';

const start = (): Scenario => initialScenario(project, 'rec');
const reduce = (s: Scenario | null, e: Parameters<typeof scenarioReducer>[1]) => scenarioReducer(s, e)!;

describe('kunci aksi', () => {
  it('komponen bertarget dibedakan per target, yang lain per komponen', () => {
    expect(componentKey('redis', { hit: 80 })).toBe('redis');
    expect(componentKey('replica', { db: 'pg', share: 80 })).toBe('replica:pg');
    expect(componentKey('queue', { workload: 'report' })).toBe('queue:report');
    expect(actionKeyOf(recAction('split-api'))).toBe('rec:split-api');
  });
});

describe('skenario awal', () => {
  it('dimulai dari rekomendasi (default) atau dari kondisi sekarang', () => {
    expect(initialScenario(project, 'rec').actions).toEqual([recAction('split-api')]);
    expect(initialScenario(project, 'now').actions).toEqual([]);
  });
  it('gangguan menyala otomatis hanya bila nyata (bukan asumsi); beban disalin, bukan dibagi', () => {
    expect(initialScenario(project).faults).toBe(false);
    expect(initialScenario({ ...project, faultsAssumed: false }).faults).toBe(true);
    expect(initialScenario({ ...project, faultsAssumed: false, faults: [] }).faults).toBe(false);
    const s = initialScenario(project); s.load.users = 1; expect(project.load.users).toBe(500);
  });
});

describe('reducer', () => {
  it('toggleRec menambah lalu melepas', () => {
    let s = reduce(start(), { type: 'toggleRec', id: 'flush2' });
    expect(s.actions.map(actionKeyOf)).toEqual(['rec:split-api', 'rec:flush2']);
    s = reduce(s, { type: 'toggleRec', id: 'split-api' });
    expect(s.actions.map(actionKeyOf)).toEqual(['rec:flush2']);
  });
  it('setComponent memperbarui yang berkunci sama dan menambah yang berbeda target', () => {
    let s = reduce(start(), { type: 'setComponent', component: 'redis', params: { hit: 80 } });
    s = reduce(s, { type: 'setComponent', component: 'redis', params: { hit: 95 } });
    expect(s.actions.filter((a) => a.kind === 'component')).toEqual([componentAction('redis', { hit: 95 })]);
    s = reduce(s, { type: 'setComponent', component: 'replica', params: { db: 'pg', share: 80 } });
    s = reduce(s, { type: 'setComponent', component: 'replica', params: { db: 'pg2', share: 60 } });
    expect(s.actions.map(actionKeyOf)).toEqual(['rec:split-api', 'redis', 'replica:pg', 'replica:pg2']);
  });
  it('removeAction dan clearActions', () => {
    let s = reduce(start(), { type: 'setComponent', component: 'redis', params: { hit: 80 } });
    s = reduce(s, { type: 'removeAction', key: 'redis' }); expect(s.actions.map(actionKeyOf)).toEqual(['rec:split-api']);
    expect(reduce(s, { type: 'clearActions' }).actions).toEqual([]);
  });
  it('setLoad, setSeconds, setFaults; restore menggantikan semuanya; tanpa skenario, perubahan diabaikan', () => {
    let s = reduce(start(), { type: 'setLoad', load: { ...load, users: 9 } }); expect(s.load.users).toBe(9);
    s = reduce(s, { type: 'setSeconds', seconds: 60 }); s = reduce(s, { type: 'setFaults', on: true });
    expect([s.seconds, s.faults]).toEqual([60, true]);
    const restored = reduce(s, { type: 'restore', scenario: { project: 'x', actions: [], load, seconds: 30, faults: false, failure: null } });
    expect(restored.project).toBe('x'); expect(restored.seconds).toBe(30);
    expect(scenarioReducer(null, { type: 'clearActions' })).toBeNull();
  });
});

describe('skenario kegagalan', () => {
  it('diatur, diganti, dan dimatikan; init selalu mulai tanpa kegagalan', () => {
    let s = reduce(start(), { type: 'setFailure', failure: { node: 'pg', at: 30, len: 40 } });
    expect(s.failure).toEqual({ node: 'pg', at: 30, len: 40 });
    s = reduce(s, { type: 'setFailure', failure: { node: 'api', at: 10, len: 0 } }); expect(s.failure?.node).toBe('api');
    expect(reduce(s, { type: 'setFailure', failure: null }).failure).toBeNull();
    expect(reduce(s, { type: 'init', project, start: 'rec' }).failure).toBeNull();
  });
  it('komponen HA database dan database terpisah dibedakan per target', () => {
    expect(componentKey('hadb', { db: 'pg' })).toBe('hadb:pg'); expect(componentKey('dbsplit', { workload: 'report' })).toBe('dbsplit:report');
    expect(componentKey('filter', { blockPct: 10 })).toBe('filter');
  });
});

describe('beban', () => {
  it('total dan puncak request per detik', () => {
    expect(totalRps(load)).toBe(50);
    expect(peakRps({ ...load, spike: { ...load.spike, on: true, mult: 4 } })).toBe(200);
  });
});

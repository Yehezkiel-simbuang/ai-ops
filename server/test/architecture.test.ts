// Peran komponen dan aturan penempatan: mana yang sebaiknya satu server yang sama, mana yang berbeda.
import { describe, expect, it } from 'vitest';
import { architecture, classify, edges, imageName, placements, type SvcIn } from '../src/loadtest/roles.js';

const svc = (name: string, image: string, published = false): SvcIn => ({ name, image, published });
const roles = (s: SvcIn[]) => Object.fromEntries(classify(s).map((n) => [n.name, n.role]));

describe('peran komponen', () => {
  it('nama image diambil tanpa registry dan tag', () => {
    expect(imageName('ghcr.io/akun/qdrant/qdrant:v1.12.0')).toBe('qdrant'); expect(imageName('postgres:17-alpine')).toBe('postgres'); expect(imageName('nginx@sha256:abc')).toBe('nginx'); expect(imageName('redis')).toBe('redis');
  });

  it('database, cache, antrean, vector, dan pencarian dikenali dari image-nya; image lain dianggap aplikasi', () => {
    expect(roles([svc('db', 'postgres:17'), svc('m', 'mariadb:11'), svc('c', 'redis:7-alpine'), svc('v', 'valkey/valkey:8'), svc('q', 'rabbitmq:4'), svc('vec', 'qdrant/qdrant:v1.12.0'), svc('s', 'opensearchproject/opensearch:2'), svc('api', 'ghcr.io/akun/api:1.0')]))
      .toEqual({ db: 'db', m: 'db', c: 'cache', v: 'cache', q: 'queue', vec: 'vector', s: 'search', api: 'app' });
  });

  it('satu-satunya nginx: proxy bila ada aplikasi di belakangnya, aplikasi bila berdiri sendiri (situs statis)', () => {
    expect(roles([svc('web', 'nginx:1.27', true), svc('api', 'ghcr.io/akun/api:1')])).toEqual({ web: 'proxy', api: 'app' });
    expect(roles([svc('web', 'nginx:1.27', true), svc('cache', 'redis:7')])).toEqual({ web: 'app', cache: 'cache' });
  });

  it('beberapa web server: yang bertugas membagi beban (haproxy atau bernama lb) menjadi proxy, sisanya aplikasi', () => {
    expect(roles([svc('web1', 'nginx:1.27'), svc('web2', 'nginx:1.27'), svc('lb', 'haproxy:3.0-alpine', true)])).toEqual({ web1: 'app', web2: 'app', lb: 'proxy' });
    expect(roles([svc('app1', 'nginx:1.27'), svc('app2', 'nginx:1.27'), svc('lb', 'nginx:1.27', true)])).toEqual({ app1: 'app', app2: 'app', lb: 'proxy' });
  });

  it('arah lalu lintas: proxy ke aplikasi, aplikasi ke data; komponen data tidak saling memanggil', () => {
    const e = edges(classify([svc('lb', 'haproxy:3', true), svc('a1', 'x/api:1'), svc('a2', 'x/api:1'), svc('db', 'postgres:17'), svc('c', 'redis:7')])).map((x) => `${x.from}>${x.to}`).sort();
    expect(e).toEqual(['a1>c', 'a1>db', 'a2>c', 'a2>db', 'lb>a1', 'lb>a2']);
  });
});

describe('aturan penempatan', () => {
  const full = [svc('lb', 'nginx:1.27', true), svc('api', 'x/api:1'), svc('db', 'postgres:17'), svc('cache', 'redis:7'), svc('mq', 'rabbitmq:4'), svc('vec', 'qdrant/qdrant:v1')];
  const rel = (a: string, b: string) => placements(classify(full)).find((p) => p.a === a && p.b === b)?.relation;

  it('proxy dan aplikasi sebaiknya satu server; aplikasi dan database, antrean, serta vector database sebaiknya berbeda', () => {
    expect(rel('proxy', 'app')).toBe('sama'); expect(rel('app', 'cache')).toBe('sama');
    for (const b of ['db', 'queue', 'vector']) expect(rel('app', b), `app-${b}`).toBe('beda');
    expect(rel('db', 'vector')).toBe('beda'); expect(rel('db', 'cache')).toBe('bebas');
  });

  it('hanya pasangan peran yang ada di susunan yang disebut, masing-masing dengan alasan', () => {
    const p = placements(classify([svc('api', 'x/api:1'), svc('db', 'postgres:17')]));
    expect(p).toHaveLength(1); expect(p[0]).toMatchObject({ a: 'app', b: 'db', relation: 'beda' }); expect(p[0]!.why.length).toBeGreaterThan(30);
    for (const x of placements(classify(full))) expect(x.why.length, `${x.a}-${x.b}`).toBeGreaterThan(30);
  });
});

describe('susunan yang disarankan', () => {
  const where = (a: ReturnType<typeof architecture>, name: string) => a.advised.find((b) => b.nodes.some((n) => n.name === name))?.id;

  it('aplikasi + database + cache + antrean: proxy, aplikasi, dan cache satu server; database dan antrean di server data', () => {
    const a = architecture([svc('web', 'nginx:1.27', true), svc('api', 'x/api:1'), svc('db', 'postgres:17'), svc('cache', 'redis:7'), svc('mq', 'rabbitmq:4')]);
    expect(a.changed).toBe(true); expect(a.current).toHaveLength(1); expect(a.current[0]!.nodes).toHaveLength(5);
    expect(where(a, 'web')).toBe('app1'); expect(where(a, 'api')).toBe('app1'); expect(where(a, 'cache')).toBe('app1'); expect(where(a, 'db')).toBe('data'); expect(where(a, 'mq')).toBe('data');
  });

  it('beberapa aplikasi: load balancer sendiri, replika disebar ke dua server aplikasi, dan cache ikut server data (dibagi bersama)', () => {
    const a = architecture([svc('lb', 'haproxy:3', true), svc('a1', 'x/api:1'), svc('a2', 'x/api:1'), svc('db', 'postgres:17'), svc('cache', 'redis:7')]);
    expect(where(a, 'lb')).toBe('lb'); expect(where(a, 'a1')).toBe('app1'); expect(where(a, 'a2')).toBe('app2'); expect(where(a, 'db')).toBe('data'); expect(where(a, 'cache')).toBe('data');
    expect(a.notes.join(' ')).toMatch(/disebar ke server berbeda/);
  });

  it('vector database dan mesin pencari masing-masing server sendiri', () => {
    const a = architecture([svc('api', 'x/api:1', true), svc('vec', 'qdrant/qdrant:v1'), svc('s', 'elasticsearch:8')]);
    expect(where(a, 'vec')).toMatch(/^vec-/); expect(where(a, 's')).toMatch(/^srch-/); expect(where(a, 'api')).toBe('app1');
  });

  it('susunan kecil tanpa yang wajib dipisah: tidak mengusulkan perubahan dan menjelaskannya', () => {
    const a = architecture([svc('web', 'nginx:1.27', true), svc('cache', 'redis:7')]);
    expect(a.changed).toBe(false); expect(a.advised).toEqual(a.current); expect(a.notes.join(' ')).toMatch(/Tidak ada komponen yang wajib dipisah/);
  });

  it('setiap komponen tepat satu kali di setiap susunan', () => {
    const a = architecture([svc('lb', 'haproxy:3', true), svc('a1', 'x/api:1'), svc('a2', 'x/api:1'), svc('db', 'postgres:17'), svc('cache', 'redis:7'), svc('mq', 'rabbitmq:4'), svc('vec', 'qdrant/qdrant:v1')]);
    for (const layout of [a.current, a.advised]) expect(layout.flatMap((b) => b.nodes.map((n) => n.name)).sort()).toEqual(a.nodes.map((n) => n.name).sort());
  });
});

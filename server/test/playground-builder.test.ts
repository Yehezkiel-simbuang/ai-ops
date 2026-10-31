import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildCompose } from '../src/playground/builder.js';
import { analyze } from '../src/playground/compose.js';

const app = { image: 'ghcr.io/contoh/api:1.2', port: 3000 };
describe('perakit susunan', () => {
  it('aplikasi tunggal + postgres + redis: valid, satu port terbuka, ketergantungan menunggu sehat', () => {
    const y = buildCompose({ app: { ...app, healthPath: '/health' }, db: { kind: 'postgres' }, redis: {} }), a = analyze(y), d = parse(y);
    expect(a.problems).toEqual([]); expect(a.publish).toEqual([{ service: 'app', host: 8080, container: 3000 }]);
    expect(Object.keys(d.services).sort()).toEqual(['app', 'cache', 'db']);
    expect(d.services.app.environment).toMatchObject({ DATABASE_URL: 'postgres://app:app@db:5432/app', REDIS_URL: 'redis://cache:6379' });
    expect(d.services.app.depends_on).toEqual({ db: { condition: 'service_healthy' }, cache: { condition: 'service_healthy' } });
  });
  it('replika > 1: lb yang mempublikasikan port, aplikasi tidak; nginx dan haproxy memuat semua replika', () => {
    for (const lb of ['nginx', 'haproxy'] as const) {
      const y = buildCompose({ app: { ...app, replicas: 3 }, lb }), d = parse(y), a = analyze(y);
      expect(a.problems).toEqual([]); expect(a.publish.map((p) => p.service)).toEqual(['lb']);
      expect(Object.keys(d.services)).toEqual(['app1', 'app2', 'app3', 'lb']);
      for (const n of ['app1:3000', 'app2:3000', 'app3:3000']) expect(d.configs.lbconf.content).toContain(n);
    }
  });
  it('konfigurasi Nginx meng-escape $ agar tidak ditafsirkan Compose sebagai variabel', () => {
    expect(parse(buildCompose({ app: { ...app, replicas: 2 }, lb: 'nginx' })).configs.lbconf.content).toContain('proxy_set_header Host $$host;');
  });
  it('setiap layanan diberi restart: unless-stopped, dan compose tanpa restart diberi peringatan', () => {
    const d = parse(buildCompose({ app: { ...app, replicas: 2 }, db: { kind: 'mysql' }, redis: {} }));
    for (const [n, s] of Object.entries<any>(d.services)) expect(s.restart, n).toBe('unless-stopped');
    expect(analyze(buildCompose({ app }) ).warnings.join('|')).not.toMatch(/restart/);
    expect(analyze(['services:', '  a:', '    image: x:1', '    ports: ["8080:80"]', ''].join(String.fromCharCode(10))).warnings.join('|')).toMatch(/tanpa "restart"/);
  });
  it('batas CPU dan memori dipasang per komponen', () => {
    const d = parse(buildCompose({ app: { ...app, limits: { cpus: 0.5, memory: '512M' } }, db: { kind: 'mysql', limits: { memory: '1g' } } }));
    expect(d.services.app.deploy.resources.limits).toEqual({ cpus: '0.5', memory: '512m' }); expect(d.services.db.deploy.resources.limits).toEqual({ memory: '1g' });
  });
  it('masukan tidak wajar ditolak: image berisi spasi/shell, replika terlalu banyak, port rendah, memori salah, nama env buruk', () => {
    for (const bad of [{ app: { image: 'x; rm -rf /' } }, { app: { ...app, replicas: 9 } }, { app: app, publishPort: 80 }, { app: { ...app, limits: { memory: 'banyak' } } }, { app: { ...app, env: { 'A B': '1' } } }]) expect(() => buildCompose(bad)).toThrow();
  });
});

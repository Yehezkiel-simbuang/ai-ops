// Pagar compose Playground. Audit keamanan menemukan empat cara melewatinya: kunci merge (<<), volume bernama yang mengikat folder host,
// secrets/configs dengan file di host, dan opsi keamanan yang tidak diperiksa. Pagar ini memakai YAML yang sama seperti Docker Compose.
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/playground/compose.js';

const svc = (extra = '', image = 'nginx:1.27') => `services:\n  web:\n    image: ${image}\n    ports: ["8080:80"]\n    healthcheck: { test: ["CMD", "true"] }\n${extra}`;
const problems = (yml: string): string => analyze(yml).problems.join(' | ');

describe('pagar compose: bentuk yang dulu lolos kini ditolak', () => {
  it('kunci merge << tidak lagi menyembunyikan privileged, network_mode host, dan cap_add', () => {
    const p = problems(`x-p: &p\n  privileged: true\n  network_mode: host\n  cap_add: [SYS_ADMIN]\nservices:\n  web:\n    <<: *p\n    image: nginx:1.27\n    ports: ["8080:80"]\n`);
    expect(p).toMatch(/privileged/); expect(p).toMatch(/network_mode: host/); expect(p).toMatch(/cap_add/);
  });
  it('merge bertingkat dan daftar anchor juga diperluas', () => {
    expect(problems(`a: &a { privileged: true }\nb: &b { <<: *a }\nservices:\n  web: { <<: *b, image: "nginx:1.27" }\n`)).toMatch(/privileged/);
    expect(problems(`a: &a { pid: host }\nb: &b { ipc: host }\nservices:\n  web: { <<: [*a, *b], image: "nginx:1.27" }\n`)).toMatch(/pid: host.*ipc: host|ipc: host.*pid: host/s);
  });
  it('volume bernama dengan driver_opts yang mengikat folder host ditolak (bind, device absolut, ~, ..)', () => {
    for (const o of ['{ type: none, o: bind, device: / }', '{ o: "bind,ro", device: /etc }', '{ type: bind, device: ./x }', '{ device: "/var/run" }', '{ device: "~/x" }', '{ device: "../../etc" }']) {
      expect(problems(svc(`    volumes: ["v:/host"]\nvolumes:\n  v:\n    driver_opts: ${o}\n`)), o).toMatch(/Volume "v": "driver_opts"/);
    }
  });
  it('secrets dan configs dengan file di host ditolak; content, environment, dan external diterima', () => {
    expect(problems(svc('    secrets: [s]\nsecrets:\n  s:\n    file: /etc/shadow\n'))).toMatch(/Secret "s": "file: \/etc\/shadow"/);
    expect(problems(svc('    configs: [c]\nconfigs:\n  c:\n    file: ../../root/.ssh/id_ed25519\n'))).toMatch(/Config "c"/);
    expect(problems(svc('    configs: [c]\nconfigs:\n  c:\n    file: ~/x\n'))).toMatch(/Config "c"/);
    for (const ok of ['secrets:\n  s:\n    environment: DB_PASS\n', 'secrets:\n  s:\n    external: true\n', 'configs:\n  c:\n    content: "a=1"\n']) expect(problems(svc(`    secrets: [s]\n${ok}`)), ok).toBe('');
  });
  it('opsi lain yang menembus isolasi: label:disable, cgroup_parent, device_cgroup_rules, pid/ipc container:, extends, include', () => {
    expect(problems(svc('    security_opt: ["label:disable"]\n'))).toMatch(/unconfined/); expect(problems(svc('    security_opt: ["label=disable"]\n'))).toMatch(/unconfined/);
    expect(problems(svc('    cgroup_parent: /\n'))).toMatch(/cgroup_parent/); expect(problems(svc('    device_cgroup_rules: ["c *:* rmw"]\n'))).toMatch(/device_cgroup_rules/);
    expect(problems(svc('    pid: "container:abc"\n'))).toMatch(/pid/); expect(problems(svc('    ipc: "container:abc"\n'))).toMatch(/ipc/);
    expect(problems(svc('    extends: { file: x.yml, service: y }\n'))).toMatch(/extends/); expect(problems(`include: [other.yml]\n${svc()}`)).toMatch(/include/);
  });
  it('yang sudah ditolak tetap ditolak (kontrol): privileged, docker.sock, host mount, devices, env_file, build', () => {
    expect(problems(svc('    privileged: true\n'))).toMatch(/privileged/); expect(problems(svc('    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n'))).toMatch(/docker\.sock/);
    expect(problems(svc('    volumes: ["../x:/x"]\n'))).toMatch(/luar proyek/); expect(problems(svc('    devices: ["/dev/sda:/dev/sda"]\n'))).toMatch(/devices/);
    expect(problems(svc('    env_file: .env\n'))).toMatch(/env_file/); expect(problems(`services:\n  web:\n    build: .\n`)).toMatch(/build/);
  });
});

describe('pagar compose: susunan wajar tetap lolos', () => {
  it('web + database dengan volume bernama, tmpfs, NFS, secrets dari environment, dan batas sumber daya', () => {
    const a = analyze(`services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    volumes: ["data:/var/www", "cache:/cache", "./conf:/etc/nginx/conf.d:ro"]
    secrets: [dbpass]
    healthcheck: { test: ["CMD", "true"] }
    deploy: { resources: { limits: { cpus: "1", memory: 256M } } }
  db:
    image: postgres:17-alpine
    environment: { POSTGRES_PASSWORD_FILE: /run/secrets/dbpass }
    secrets: [dbpass]
    healthcheck: { test: ["CMD", "true"] }
volumes:
  data: {}
  cache: { driver_opts: { type: tmpfs, device: tmpfs, o: "size=64m" } }
  nfs: { driver_opts: { type: nfs, o: "addr=10.0.0.5,rw", device: ":/export/data" } }
secrets:
  dbpass: { environment: DB_PASS }
`);
    expect(a.problems).toEqual([]); expect(a.services.map((s) => s.name)).toEqual(['web', 'db']); expect(a.publish).toEqual([{ service: 'web', host: 8080, container: 80 }]);
  });
  it('merge key yang tidak berbahaya (berbagi healthcheck dan environment) tetap diterima', () => {
    const a = analyze(`x-common: &common\n  restart: unless-stopped\n  environment: { TZ: Asia/Jakarta }\n  healthcheck: { test: ["CMD", "true"] }\nservices:\n  a: { <<: *common, image: "nginx:1.27", ports: ["8080:80"] }\n  b: { <<: *common, image: "redis:7.4" }\n`);
    expect(a.problems).toEqual([]); expect(a.services).toHaveLength(2); expect(a.warnings.some((w) => /tanpa healthcheck/.test(w))).toBe(false);   // healthcheck ikut diwarisi lewat merge
  });
  it('registri tidak dikenal diberi peringatan, bukan penolakan; registri umum tidak', () => {
    expect(analyze(svc('', 'evil.example/miner:1')).warnings.join(' ')).toMatch(/registri "evil\.example" yang tidak dikenal/); expect(analyze(svc('', 'evil.example/miner:1')).problems).toEqual([]);
    for (const img of ['ghcr.io/org/app:1', 'quay.io/x/y:2', 'postgres:17', 'library/nginx:1.27', 'mcr.microsoft.com/mssql/server:2022']) expect(analyze(svc('', img)).warnings.join(' '), img).not.toMatch(/registri/);
  });
  it('bom alias YAML ditolak sebagai YAML tidak valid, bukan menghabiskan memori', () => {
    const lol = ['a: &a [x,x,x,x,x,x,x,x,x]', ...Array.from({ length: 12 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(9).fill(`*${String.fromCharCode(97 + i)}`).join(',')}]`), 'services:\n  w: { image: "x:1" }'].join('\n');
    const r = analyze(lol); expect(r.problems.length).toBeGreaterThan(0);
  });
});

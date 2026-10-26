// Peran tiap komponen dalam susunan yang diuji (proxy, aplikasi, database, cache, antrean, ...) dan aturan penempatannya:
// mana yang sebaiknya SATU server yang sama, mana yang sebaiknya server BERBEDA. Murni dan deterministik; bisa diuji.

export type Role = 'proxy' | 'app' | 'db' | 'cache' | 'queue' | 'vector' | 'search';
export const ROLE_LABEL: Record<Role, string> = { proxy: 'Proxy / load balancer', app: 'Aplikasi', db: 'Database', cache: 'Cache', queue: 'Antrean pesan', vector: 'Vector database', search: 'Mesin pencari' };

export interface SvcIn { name: string; image: string; published?: boolean }
export interface Node { name: string; image: string; role: Role; entry: boolean }
export interface Edge { from: string; to: string; label: string }

/** Nama image tanpa registry dan tag: "ghcr.io/akun/qdrant/qdrant:v1.12" -> "qdrant". */
export const imageName = (image: string): string => (image.split('@')[0]!.split(':')[0]!.split('/').pop() ?? '').toLowerCase();

const KIND: Array<[RegExp, Role | 'edge']> = [
  [/^(postgres|postgresql|mysql|mariadb|mongo|mongodb|cockroachdb|clickhouse|timescaledb|percona)/, 'db'],
  [/^(redis|valkey|memcached|keydb|dragonfly)/, 'cache'],
  [/^(rabbitmq|nats|kafka|redpanda|activemq)/, 'queue'],
  [/^(qdrant|milvus|weaviate|chroma|chromadb)/, 'vector'],
  [/^(elasticsearch|opensearch|meilisearch|typesense)/, 'search'],
  [/^(nginx|haproxy|caddy|traefik|envoy|httpd|apache)/, 'edge']
];
const LB_IMAGE = /^(haproxy|traefik|envoy)/, LB_NAME = /(^|[-_])(lb|proxy|gateway|ingress|front|edge)([-_]|$)/;

/** Tentukan peran. Image web server (nginx dkk.) menjadi proxy bila ada aplikasi di belakangnya atau ia berperan sebagai load balancer; selain itu ia dianggap aplikasi (mis. situs statis). */
export function classify(services: SvcIn[]): Node[] {
  const kind = services.map((s) => ({ s, k: (KIND.find(([re]) => re.test(imageName(s.image)))?.[1] ?? 'app') as Role | 'edge' }));
  const edge = kind.filter((x) => x.k === 'edge'), others = kind.filter((x) => x.k === 'app');
  const isProxy = (x: (typeof kind)[number]): boolean => {
    if (x.k !== 'edge') return false;
    if (edge.length === 1) return others.length > 0;   // satu-satunya web server: proxy hanya bila ada aplikasi di belakangnya
    return LB_IMAGE.test(imageName(x.s.image)) || LB_NAME.test(x.s.name);   // beberapa web server: yang bertugas membagi beban
  };
  return kind.map((x) => ({ name: x.s.name, image: x.s.image, role: (x.k === 'edge' ? (isProxy(x) ? 'proxy' : 'app') : x.k) as Role, entry: !!x.s.published }));
}

/** Arah lalu lintas: pengunjung ke titik masuk, proxy ke aplikasi, aplikasi ke data. */
export function edges(nodes: Node[]): Edge[] {
  const by = (r: Role) => nodes.filter((n) => n.role === r), out: Edge[] = [], apps = by('app'), proxies = by('proxy');
  for (const p of proxies) for (const a of apps) out.push({ from: p.name, to: a.name, label: 'HTTP' });
  const label: Partial<Record<Role, string>> = { db: 'SQL', cache: 'cache', queue: 'pesan', vector: 'vektor', search: 'pencarian' };
  for (const a of apps) for (const r of ['db', 'cache', 'queue', 'vector', 'search'] as Role[]) for (const d of by(r)) out.push({ from: a.name, to: d.name, label: label[r]! });
  return out;
}

export interface Placement { a: Role; b: Role; relation: 'sama' | 'beda' | 'bebas'; why: string; condition?: string }

const RULES: Placement[] = [
  { a: 'proxy', b: 'app', relation: 'sama', why: 'Proxy dan aplikasi saling bicara di setiap request; satu server menghilangkan satu lompatan jaringan dan keduanya sama-sama tanpa data.', condition: 'Pisahkan proxy menjadi load balancer sendiri hanya bila aplikasi berjalan di lebih dari satu server.' },
  { a: 'app', b: 'db', relation: 'beda', why: 'Database berebut CPU, memori, dan disk dengan aplikasi. Terpisah, masing-masing bisa di-tuning dan dinaikkan kapasitasnya sendiri, dan gangguan satu tidak langsung menjatuhkan yang lain.' },
  { a: 'app', b: 'cache', relation: 'sama', why: 'Cache dipakai di hampir setiap request; di server yang sama akses-nya paling cepat.', condition: 'Pisahkan cache bila aplikasi berjalan di beberapa server (semuanya harus berbagi isi cache yang sama).' },
  { a: 'app', b: 'queue', relation: 'beda', why: 'Antrean pesan harus tetap hidup dan menyimpan pesan walau aplikasi di-restart atau di-deploy; ia juga butuh disk dan memori sendiri.' },
  { a: 'app', b: 'vector', relation: 'beda', why: 'Vector database rakus memori dan CPU saat membangun dan mencari indeks, sehingga mudah mengganggu aplikasi di server yang sama.' },
  { a: 'app', b: 'search', relation: 'beda', why: 'Mesin pencari memakai banyak memori (heap) dan I/O disk; sebaiknya tidak berebut dengan aplikasi.' },
  { a: 'db', b: 'cache', relation: 'bebas', why: 'Keduanya haus memori. Boleh satu server data kecil bila RAM cukup; pisahkan bila saling mengganggu.' },
  { a: 'db', b: 'vector', relation: 'beda', why: 'Keduanya haus memori dan I/O disk; digabung, indeks vektor dan query database saling memperlambat.' },
  { a: 'db', b: 'queue', relation: 'bebas', why: 'Boleh satu server data bila beban keduanya kecil; pisahkan bila antrean ramai.' }
];

/** Aturan penempatan hanya untuk pasangan peran yang ada di susunan ini. */
export function placements(nodes: Node[]): Placement[] {
  const has = new Set(nodes.map((n) => n.role));
  return RULES.filter((r) => has.has(r.a) && has.has(r.b));
}

export interface ServerBox { id: string; label: string; note: string; nodes: Array<Pick<Node, 'name' | 'image' | 'role'>> }
export interface Architecture { nodes: Node[]; edges: Edge[]; placements: Placement[]; current: ServerBox[]; advised: ServerBox[]; changed: boolean; notes: string[] }

const pick = (n: Node) => ({ name: n.name, image: n.image, role: n.role });

/** Susunan sekarang (semua di satu server) dan susunan yang disarankan. Hanya mengelompokkan; tidak menebak kapasitas. */
export function architecture(services: SvcIn[]): Architecture {
  const nodes = classify(services), by = (r: Role) => nodes.filter((n) => n.role === r), apps = by('app');
  const current: ServerBox[] = [{ id: 'now', label: 'Satu server uji', note: 'Semua komponen berbagi CPU, memori, dan disk yang sama.', nodes: nodes.map(pick) }];
  const advised: ServerBox[] = [], notes: string[] = [];
  const multiApp = apps.length >= 2, proxies = by('proxy');
  if (multiApp && proxies.length) advised.push({ id: 'lb', label: 'Server load balancer', note: 'Membagi lalu lintas ke server aplikasi. Terpisah supaya satu server aplikasi mati tidak menjatuhkan pembaginya.', nodes: proxies.map(pick) });
  if (multiApp) {
    const half = Math.ceil(apps.length / 2);
    advised.push({ id: 'app1', label: 'Server aplikasi 1', note: 'Replika aplikasi tanpa data; mudah ditambah.', nodes: apps.slice(0, half).map(pick) });
    advised.push({ id: 'app2', label: 'Server aplikasi 2', note: 'Replika lain di server berbeda: bila satu server mati, yang lain tetap melayani.', nodes: apps.slice(half).map(pick) });
    notes.push('Replika aplikasi disebar ke server berbeda; replika di satu server yang sama hanya menambah kapasitas sampai CPU server itu habis, bukan ketahanan.');
  } else if (apps.length || proxies.length) {
    advised.push({ id: 'app1', label: 'Server aplikasi', note: 'Proxy dan aplikasi satu server: lompatan jaringan paling sedikit.', nodes: [...proxies, ...apps].map(pick) });
  }
  const data = [...by('db'), ...(multiApp ? by('cache') : []), ...by('queue')];
  if (by('db').length || by('queue').length || (multiApp && by('cache').length)) advised.push({ id: 'data', label: 'Server data', note: 'Database (dan cache bersama atau antrean bila ada) dengan disk dan memori sendiri.', nodes: data.map(pick) });
  if (!multiApp && by('cache').length) { const a = advised.find((x) => x.id === 'app1'); if (a) a.nodes.push(...by('cache').map(pick)); else advised.push({ id: 'app1', label: 'Server aplikasi', note: 'Cache di server yang sama dengan aplikasi.', nodes: by('cache').map(pick) }); }
  for (const v of by('vector')) advised.push({ id: `vec-${v.name}`, label: 'Server vector database', note: 'Memori dan CPU besar untuk indeks; dipisah agar tidak mengganggu yang lain.', nodes: [pick(v)] });
  for (const s of by('search')) advised.push({ id: `srch-${s.name}`, label: 'Server pencarian', note: 'Heap dan I/O besar; dipisah dari aplikasi.', nodes: [pick(s)] });
  const needSplit = placements(nodes).some((p) => p.relation === 'beda') || multiApp;
  if (!needSplit) notes.push('Tidak ada komponen yang wajib dipisah untuk susunan ini. Satu server cukup selama bottleneck belum muncul; pisahkan database lebih dulu saat tumbuh.');
  return { nodes, edges: edges(nodes), placements: placements(nodes), current, advised: needSplit ? advised : current, changed: needSplit, notes };
}

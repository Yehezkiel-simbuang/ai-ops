import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { mockApi, renderWithProviders } from '@/test/utils';
import { ArchitectureView } from './ArchitectureView';
import { BottleneckPanel } from './BottleneckPanel';
import { finished, running } from './fixtures';
import { LoadTestDetailPage } from './LoadTestDetailPage';
import { LoadTestsPage } from './LoadTestsPage';
import { NewLoadTestPage } from './NewLoadTestPage';
import type { Architecture, BottleneckReport } from './types';

afterEach(() => vi.unstubAllGlobals());

const node = (name: string, role: Architecture['nodes'][number]['role'], image = `${role}:1`) => ({ name, role, image });
const NODES: Architecture['nodes'] = [{ ...node('lb', 'proxy', 'haproxy:3'), entry: true }, { ...node('api', 'app', 'x/api:1'), entry: false }, { ...node('db', 'db', 'postgres:17'), entry: false }, { ...node('cache', 'cache', 'redis:7'), entry: false }];
const arch = (changed = true): Architecture => ({
  nodes: NODES, edges: [{ from: 'lb', to: 'api', label: 'HTTP' }, { from: 'api', to: 'db', label: 'SQL' }, { from: 'api', to: 'cache', label: 'cache' }],
  placements: [{ a: 'proxy', b: 'app', relation: 'sama', why: 'Proxy dan aplikasi saling bicara di setiap request; satu server menghilangkan satu lompatan.', condition: 'Pisahkan hanya bila aplikasi di lebih dari satu server.' }, { a: 'app', b: 'db', relation: 'beda', why: 'Database berebut CPU dan memori dengan aplikasi.' }, { a: 'db', b: 'cache', relation: 'bebas', why: 'Boleh satu server data kecil.' }],
  current: [{ id: 'now', label: 'Satu server uji', note: 'Semua berbagi sumber daya.', nodes: NODES.map(({ name, image, role }) => ({ name, image, role })) }],
  advised: changed ? [{ id: 'app1', label: 'Server aplikasi', note: 'Proxy dan aplikasi satu server.', nodes: [node('lb', 'proxy'), node('api', 'app'), node('cache', 'cache')] }, { id: 'data', label: 'Server data', note: 'Database dengan disk sendiri.', nodes: [node('db', 'db')] }] : [{ id: 'now', label: 'Satu server uji', note: 'Semua berbagi sumber daya.', nodes: NODES.map(({ name, image, role }) => ({ name, image, role })) }],
  changed, notes: changed ? [] : ['Tidak ada komponen yang wajib dipisah untuk susunan ini.']
});
const report = (over: Partial<BottleneckReport> = {}): BottleneckReport => ({
  basis: 'terukur', stageIdx: 2, headline: 'db jenuh (CPU 190%).', cautions: ['Server uji penuh dan lebih dari satu komponen ikut tinggi: angka tiap komponen saling memengaruhi.'],
  findings: [
    { component: 'db', role: 'db', confidence: 'terukur', title: 'db jenuh (CPU 190%)', evidence: ['CPU 190% dari kapasitasnya pada tahap 3 (80 pengguna).'], advice: ['Periksa query lambat dan tambahkan index.'], score: 100 },
    { component: 'api', role: 'app', confidence: 'dugaan', title: 'Aplikasi kemungkinan menjadi penyempit', evidence: ['Gejala: waktu respons naik.'], advice: ['Tambah replika aplikasi.'], score: 40 }
  ],
  usage: [{ service: 'db', role: 'db', stages: [{ idx: 0, vus: 5, cpu: 0.2, mem: 0.1 }, { idx: 1, vus: 20, cpu: 0.7, mem: 0.2 }, { idx: 2, vus: 80, cpu: 1.9, mem: 0.3 }] }, { service: '_host', role: 'host', stages: [{ idx: 0, vus: 5, cpu: 0.1, mem: 0.4 }, { idx: 1, vus: 20, cpu: 0.5, mem: 0.4 }, { idx: 2, vus: 80, cpu: null, mem: null }] }], ...over
});

describe('visualisasi arsitektur', () => {
  it('menampilkan susunan sekarang dan yang disarankan, dengan tiap komponen dan server sebagai blok bernama', () => {
    renderWithProviders(<ArchitectureView arch={arch()} />);
    expect(screen.getByText('Sekarang: semua di satu server')).toBeInTheDocument(); expect(screen.getByText('Disarankan: 2 server')).toBeInTheDocument();
    const now = screen.getByRole('img', { name: 'Arsitektur yang diuji sekarang' }), adv = screen.getByRole('img', { name: 'Arsitektur yang disarankan' });
    for (const n of ['lb', 'api', 'db', 'cache']) expect(within(now).getByText(n)).toBeInTheDocument();
    expect(within(now).getByText('Satu server uji')).toBeInTheDocument(); expect(within(adv).getByText('Server aplikasi')).toBeInTheDocument(); expect(within(adv).getByText('Server data')).toBeInTheDocument();
    expect(within(adv).getAllByText('Database')).toHaveLength(1);   // peran ditulis di blok
  });

  it('garis di dalam satu server dibedakan dari garis antar server, dan ada keterangannya', () => {
    const { container } = renderWithProviders(<ArchitectureView arch={arch()} />);
    const adv = screen.getByRole('img', { name: 'Arsitektur yang disarankan' });
    expect(adv.querySelectorAll('path.arch-edge.same').length).toBeGreaterThan(0);   // lb>api dan api>cache satu server
    expect(adv.querySelectorAll('path.arch-edge.cross').length).toBe(1);   // api>db lewat jaringan
    expect(adv.querySelector('path.arch-edge.cross title')?.textContent).toMatch(/Server aplikasi ke Server data \(SQL\): lewat jaringan antar server; api ke db/);
    expect(within(adv).getByText('SQL')).toBeInTheDocument();   // jenis lalu lintas tertulis pada garisnya
    expect(screen.getByText(/satu server yang sama \(tanpa jaringan\)/)).toBeInTheDocument(); expect(screen.getByText(/server berbeda \(lewat jaringan\)/)).toBeInTheDocument(); expect(container.querySelectorAll('.arch-swatch').length).toBe(7);
  });

  it('aturan penempatan menyebut pasangan yang harus satu server, yang sebaiknya berbeda, dan yang bebas, lengkap dengan alasan dan syaratnya', () => {
    renderWithProviders(<ArchitectureView arch={arch()} />);
    const t = screen.getByRole('table', { name: 'Aturan penempatan' }), rows = within(t).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('satu server yang sama')).toBeInTheDocument(); expect(within(rows[0]!).getByText(/Pisahkan hanya bila aplikasi di lebih dari satu server/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('server berbeda')).toBeInTheDocument(); expect(within(rows[1]!).getByText(/berebut CPU dan memori/)).toBeInTheDocument(); expect(within(rows[2]!).getByText('bebas')).toBeInTheDocument();
  });

  it('susunan yang tidak perlu diubah dijelaskan, bukan dibiarkan kosong', () => {
    renderWithProviders(<ArchitectureView arch={arch(false)} />);
    expect(screen.getByText('Disarankan: tetap')).toBeInTheDocument(); expect(screen.getByText(/Tidak ada komponen yang wajib dipisah/)).toBeInTheDocument();
  });
});

describe('panel bottleneck', () => {
  it('kesimpulan, peringatan, dan temuan berperingkat dengan tingkat keyakinan, bukti, dan saran', () => {
    renderWithProviders(<BottleneckPanel report={report()} />);
    expect(screen.getByRole('status')).toHaveTextContent('db jenuh (CPU 190%).'); expect(screen.getByText('berdasar pemakaian terukur per komponen')).toBeInTheDocument(); expect(screen.getByText(/dianalisis pada tahap 3/)).toBeInTheDocument();
    expect(screen.getByText(/angka tiap komponen saling memengaruhi/)).toBeInTheDocument();
    const [first, second] = screen.getAllByRole('article');
    expect(within(first!).getByText('1. db jenuh (CPU 190%)')).toBeInTheDocument(); expect(within(first!).getByText('Terukur')).toBeInTheDocument(); expect(within(first!).getByText('Database')).toBeInTheDocument(); expect(within(first!).getByText('Periksa query lambat dan tambahkan index.')).toBeInTheDocument();
    expect(within(second!).getByText('Dugaan')).toBeInTheDocument();
  });

  it('pemakaian per komponen: sel diwarnai menurut tingkat penuhnya; yang tidak tercatat tampil strip', () => {
    renderWithProviders(<BottleneckPanel report={report()} />);
    const t = screen.getByRole('table', { name: 'Pemakaian per komponen' }), db = within(t).getByText('db').closest('tr')!, host = within(t).getByText('server uji').closest('tr')!;
    const cells = within(db).getAllByRole('cell').slice(1); expect(cells.map((c) => c.textContent)).toEqual(['20%', '70%', '190%']); expect(cells.map((c) => c.className)).toEqual(['heat ok', 'heat warn', 'heat bad']);
    expect(within(host).getAllByRole('cell')[3]!.textContent).toBe('-'); expect(within(host).getByText('Server uji (keseluruhan)')).toBeInTheDocument();
  });

  it('perkiraan tanpa pemakaian: diberi label dan dijelaskan cara mendapatkan bukti; tanpa temuan dinyatakan aman', () => {
    const { unmount } = renderWithProviders(<BottleneckPanel report={report({ basis: 'perkiraan', usage: [], cautions: [] })} />);
    expect(screen.getByText('perkiraan dari kurva hasil')).toBeInTheDocument(); expect(screen.getByText(/hanya dicatat untuk uji yang dijalankan dari susunan Playground/)).toBeInTheDocument(); expect(screen.queryByRole('table')).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<BottleneckPanel report={report({ findings: [], headline: 'Belum ada bottleneck pada beban ini.' })} />);
    expect(screen.getByRole('status')).toHaveClass('ok');
  });
});

describe('halaman hasil uji', () => {
  const page = () => renderWithProviders(<Routes><Route path="/uji-beban/:id" element={<LoadTestDetailPage />} /></Routes>, { route: '/uji-beban/5' });
  it('uji selesai dengan susunan: bagian bottleneck dan arsitektur tampil', async () => {
    mockApi({ 'GET /api/loadtests/5': { body: { ...finished(), bottleneck: report(), architecture: arch() } } });
    page();
    expect(await screen.findByRole('heading', { name: 'Di mana bottleneck-nya' })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: 'Arsitektur dan penempatan komponen' })).toBeInTheDocument(); expect(screen.getByRole('img', { name: 'Arsitektur yang disarankan' })).toBeInTheDocument();
  });
  it('tanpa susunan: hanya bagian bottleneck; uji yang masih berjalan: tidak ada keduanya', async () => {
    mockApi({ 'GET /api/loadtests/5': { body: { ...finished(), bottleneck: report({ basis: 'perkiraan', usage: [] }), architecture: null } } });
    const { unmount } = page();
    expect(await screen.findByRole('heading', { name: 'Di mana bottleneck-nya' })).toBeInTheDocument(); expect(screen.queryByRole('heading', { name: 'Arsitektur dan penempatan komponen' })).not.toBeInTheDocument();
    unmount(); vi.unstubAllGlobals();
    mockApi({ 'GET /api/loadtests/5': { body: { ...running(), bottleneck: report(), architecture: arch() } } });
    page(); await screen.findByText(/Hasil per tahap/); expect(screen.queryByRole('heading', { name: 'Di mana bottleneck-nya' })).not.toBeInTheDocument();
  });
});

describe('halaman uji baru', () => {
  const status = { enabled: true, allowedHosts: [], runner: { online: true, lastSeen: Date.now(), info: null } };
  it('tata letak penyusun: langkah bernomor, ringkasan yang ikut berubah saat mengetik, dan tanpa susunan Playground ada petunjuk', async () => {
    mockApi({ 'GET /api/loadtests/status': { body: status } });
    renderWithProviders(<Routes><Route path="/uji-beban/baru" element={<NewLoadTestPage />} /></Routes>, { route: '/uji-beban/baru' });
    const aside = await screen.findByLabelText('Ringkasan');
    for (const h of ['Apa yang diuji', 'Seberapa berat', 'Kapan dianggap sehat']) expect(screen.getByRole('heading', { name: h })).toBeInTheDocument();
    expect(within(aside).getAllByText('belum diisi')).toHaveLength(2);   // nama dan target belum diisi
    await userEvent.type(screen.getByLabelText('Target'), 'http://10.0.0.5:8080'); await userEvent.type(screen.getByPlaceholderText(/Proyek A, 1 server/), 'Uji A');
    expect(within(aside).getByText('http://10.0.0.5:8080')).toBeInTheDocument(); expect(within(aside).getByText('Uji A')).toBeInTheDocument(); expect(within(aside).getByText(/5 tahap, puncak 200 pengguna/)).toBeInTheDocument();
    expect(within(aside).getByText(/Tanpa susunan Playground, analisis hanya dari kurva hasil/)).toBeInTheDocument();
  });

  it('dari Playground: susunannya dipratinjau sebagai diagram dan dijelaskan bahwa pemakaian tiap komponen akan dicatat', async () => {
    mockApi({ 'GET /api/loadtests/status': { body: status }, 'GET /api/loadtests/preview?playground=3': { body: { setup: { name: 'toko' }, architecture: arch() } } });
    renderWithProviders(<Routes><Route path="/uji-beban/baru" element={<NewLoadTestPage />} /></Routes>, { route: '/uji-beban/baru?target=http%3A%2F%2F10.0.0.5%3A8080&nama=toko&pg=3' });
    const aside = await screen.findByLabelText('Ringkasan');
    expect(await within(aside).findByRole('img', { name: 'Susunan yang akan diuji' })).toBeInTheDocument(); expect(within(aside).getByText(/4 komponen di satu server uji/)).toBeInTheDocument(); expect(within(aside).getByText(/pemakaian CPU dan memori tiap komponen dicatat/)).toBeInTheDocument();
    expect((screen.getByLabelText('Target') as HTMLInputElement).value).toBe('http://10.0.0.5:8080'); expect(within(aside).queryByText(/Tanpa susunan Playground/)).not.toBeInTheDocument();
  });

  it('daftar uji: Uji baru membuka halaman baru; alamat dari Playground diteruskan ke halaman baru dengan parameternya', async () => {
    mockApi({ 'GET /api/loadtests/status': { body: status }, 'GET /api/loadtests': { body: [] } });
    const Where = () => <div>halaman uji baru</div>;
    const { unmount } = renderWithProviders(<Routes><Route path="/uji-beban" element={<LoadTestsPage />} /><Route path="/uji-beban/baru" element={<Where />} /></Routes>, { route: '/uji-beban' });
    await userEvent.click(await screen.findByRole('button', { name: 'Uji baru' })); expect(await screen.findByText('halaman uji baru')).toBeInTheDocument();
    unmount(); vi.unstubAllGlobals();
    mockApi({ 'GET /api/loadtests/status': { body: status }, 'GET /api/loadtests': { body: [] } });
    renderWithProviders(<Routes><Route path="/uji-beban" element={<LoadTestsPage />} /><Route path="/uji-beban/baru" element={<NewLoadTestPage />} /></Routes>, { route: '/uji-beban?target=http%3A%2F%2F10.0.0.5%3A8080&nama=toko' });
    expect(((await screen.findByLabelText('Target')) as HTMLInputElement).value).toBe('http://10.0.0.5:8080');
  });
});

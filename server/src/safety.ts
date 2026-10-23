// Kebijakan perintah untuk agen: setiap perintah diklasifikasikan sebelum dijalankan.
//   read    : hanya membaca; boleh dijalankan otomatis
//   change  : mengubah sesuatu atau tidak dikenal; WAJIB disetujui pengguna di UI
//   blocked : jelas merusak; tidak pernah dijalankan oleh agen (jalankan manual bila memang perlu)
// Prinsip: tidak dikenal = change. Tanda berbahaya apa pun pada satu segmen menaikkan seluruh perintah.
export type CommandClass = 'read' | 'change' | 'blocked';
export interface Classification { cls: CommandClass; why: string }

const BLOCKED: Array<[RegExp, string]> = [
  [/(^|[\s;&|])rm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/(\s|$|\*)/, 'rm rekursif pada /'],
  [/(^|[\s;&|])rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/\*|~\/?\s*$|\$HOME)/, 'rm rekursif pada direktori sistem/home'],
  [/\bmkfs(\.\w+)?\b/, 'format filesystem'], [/\bdd\b[^|;]*\bof=\/dev\//, 'dd menulis ke perangkat'], [/>\s*\/dev\/(sd|nvme|vd|xvd|mmcblk)/, 'menimpa perangkat blok'],
  [/(^|[\s;&|])(shutdown|reboot|halt|poweroff|init\s+[06])\b/, 'mematikan atau me-restart mesin'], [/\bsystemctl\s+(reboot|poweroff|halt|kexec)\b/, 'mematikan atau me-restart mesin'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'], [/\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'mengunduh lalu langsung menjalankan skrip'],
  [/\b(passwd|chpasswd|userdel|deluser|usermod\s+-[a-zA-Z]*L)\b/, 'mengubah akun pengguna'], [/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, 'chmod 777 pada /'],
  [/\bzpool\s+(destroy|labelclear|export)\b/, 'merusak pool ZFS'], [/\bzfs\s+destroy\b/, 'menghapus dataset ZFS'], [/\bpvesm\s+remove\b|\bqm\s+destroy\b|\bpct\s+destroy\b/, 'menghapus VM/LXC'],
  [/\bDROP\s+(DATABASE|SCHEMA)\b/i, 'DROP DATABASE'], [/\b(iptables|nft|ufw)\b[^;|&]*(-F|flush|disable)\b/, 'menghapus aturan firewall'], [/\bcrontab\s+-r\b/, 'menghapus seluruh crontab'],
  [/\bauthorized_keys\b[^;|&]*>/, 'menimpa authorized_keys'], [/>\s*\/etc\/(passwd|shadow|sudoers)/, 'menimpa berkas akun']
];

// perintah yang hanya membaca. Sub-perintah diperiksa di READ_SUB.
const READ_CMDS = new Set(['cat', 'ls', 'df', 'free', 'uptime', 'uname', 'ps', 'vmstat', 'iostat', 'mpstat', 'sar', 'pidstat', 'ss', 'netstat', 'nproc', 'lscpu', 'lsblk', 'lsof', 'mount', 'findmnt', 'dmesg', 'grep', 'egrep', 'fgrep',
  'head', 'tail', 'wc', 'stat', 'du', 'whoami', 'id', 'date', 'hostname', 'hostnamectl', 'pwd', 'echo', 'printf', 'true', 'test', '[', 'sort', 'uniq', 'cut', 'awk', 'sed', 'tr', 'column', 'basename', 'dirname', 'readlink', 'realpath', 'file', 'which', 'type',
  'command', 'env', 'printenv', 'getent', 'lsmod', 'lspci', 'lsusb', 'blkid', 'smartctl', 'sensors', 'w', 'who', 'last', 'ulimit', 'top', 'htop', 'nl', 'tac', 'less', 'more', 'md5sum', 'sha256sum', 'ping', 'dig', 'nslookup', 'host', 'traceroute', 'mtr', 'tracepath',
  'journalctl', 'systemctl', 'zpool', 'zfs', 'sysctl', 'ip', 'mysql', 'mariadb', 'mysqladmin', 'redis-cli', 'nginx', 'php-fpm', 'php-fpm8.1', 'php-fpm8.2', 'php-fpm8.3', 'php', 'apachectl', 'docker', 'pct', 'qm', 'pvesh', 'pveversion', 'pvesm', 'psql', 'find', 'curl', 'timeout', 'time', 'nice', 'ionice', 'xargs', 'tee', 'sudo']);

type SubCheck = (a: string[]) => boolean;
const has = (a: string[], f: (x: string) => boolean): boolean => a.some(f);
const READ_SUB: Record<string, SubCheck> = {
  systemctl: (a) => /^(status|is-active|is-enabled|is-failed|show|cat|list-units|list-unit-files|list-timers|list-sockets|list-dependencies)$/.test(a[0] === '--no-pager' ? a[1] || '' : a[0] || ''),
  journalctl: (a) => !has(a, (x) => /^--(vacuum|rotate|flush|sync|relinquish|setup-keys)/.test(x)),
  zpool: (a) => /^(status|list|iostat|get|history|events)$/.test(a[0] || ''),
  zfs: (a) => /^(list|get|history|diff|holds)$/.test(a[0] || ''),
  sysctl: (a) => !has(a, (x) => /=/.test(x) || x === '-w' || x === '--write' || x === '-p' || x === '--load'),
  ip: (a) => /^(-\w+\s*)*(a|addr|address|r|route|l|link|n|neigh|s|-s|maddr|rule)$/.test(a.filter((x) => x[0] !== '-')[0] || '') && !has(a, (x) => /^(add|del|delete|set|flush|replace|change)$/.test(x)),
  docker: (a) => /^(ps|stats|logs|inspect|images|info|version|top|port|diff)$/.test(a[0] || ''),
  pct: (a) => /^(list|config|status|df|listsnapshot)$/.test(a[0] || ''),
  qm: (a) => /^(list|config|status|listsnapshot)$/.test(a[0] || ''),
  pvesm: (a) => /^(status|list|path)$/.test(a[0] || ''),
  pvesh: (a) => a[0] === 'get',
  nginx: (a) => a.length === 0 || a.every((x) => /^-(t|T|v|V)$/.test(x)),
  apachectl: (a) => /^(-t|-S|-M|configtest|status)$/.test(a[0] || ''),
  php: (a) => a.every((x) => /^-(v|m|i|-ini|--version)$/.test(x)),
  'php-fpm': (a) => a.every((x) => /^-(t|tt|v|i|m)$/.test(x)),
  mount: (a) => a.length === 0 || a.every((x) => (x[0] === '-' && !/[a-zA-Z]*[aot]/.test(x.slice(1))) || x === '-l'),
  find: (a) => !has(a, (x) => /^-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)$/.test(x)),
  sed: (a) => !has(a, (x) => /^-[a-zA-Z]*i/.test(x) || x === '--in-place'),
  awk: (a) => !has(a, (x) => /system\s*\(|\|\s*getline|>\s*["']?\/|print\s*>/.test(x)),
  tee: (a) => a.length > 0 && a.every((x) => x === '/dev/null'),
  xargs: () => false, timeout: () => true, time: () => true, nice: () => true, ionice: () => true, command: (a) => /^-[vV]$/.test(a[0] || ''),
  curl: (a) => { const t = a.join(' '); return /(^|\s)(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])([:/\s]|$)/.test(t) && !/(^|\s)(-X|--request|-d|--data\S*|-F|--form|-T|--upload-file|-o\s+(?!\/dev\/null)\S+|--output\s+(?!\/dev\/null)\S+|-O)(\s|$)/.test(t); },
  ping: (a) => has(a, (x) => x === '-c'),
  top: (a) => a.includes('-b') || has(a, (x) => /^-[a-zA-Z]*b/.test(x)), htop: () => false, less: () => false, more: () => false,
  env: (a) => a.length === 0, printenv: () => true
};
// pola `a[0]` yang bisa undefined di bawah noUncheckedIndexedAccess dipertahankan lewat `|| ''`

export function splitSegments(cmd: string): string[] {
  // pecah pada ; && || | & dan baris baru di luar tanda kutip. Substitusi $(..) dan `..` diperiksa terpisah.
  const segs: string[] = []; let cur = '', q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!, n = cmd[i + 1];
    if (q) { cur += c; if (c === q && cmd[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '\n') { segs.push(cur); cur = ''; continue; }
    if ((c === '&' && n === '&') || (c === '|' && n === '|')) { segs.push(cur); cur = ''; i++; continue; }
    if (c === '|' || c === '&') { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  segs.push(cur); return segs.map((s) => s.trim()).filter(Boolean);
}
function words(seg: string): string[] { const out: string[] = []; const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g; let m: RegExpExecArray | null; while ((m = re.exec(seg))) out.push((m[1] ?? m[2] ?? m[3]) as string); return out; }
function hasWriteRedirect(seg: string): boolean { const stripped = seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""').replace(/\d*>&\d+/g, '').replace(/\d*>\s*\/dev\/null/g, '').replace(/2>&1/g, ''); return />/.test(stripped); }

// SQL: hanya SELECT/SHOW/EXPLAIN/DESCRIBE/USE
export function sqlIsRead(text: string): boolean {
  const t = String(text).replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, ' ').trim(); if (!t) return false;
  return t.split(';').map((s) => s.trim()).filter(Boolean).every((s) => /^(select|show|explain|describe|desc|use)\b/i.test(s) && !/\b(into\s+(outfile|dumpfile)|for\s+update|lock\s+in\s+share|sleep\s*\(|benchmark\s*\()/i.test(s));
}
function sqlOfArgs(a: string[]): string | null {
  const i = a.findIndex((x) => x === '-e' || x === '--execute' || /^--execute=/.test(x) || /^-e./.test(x)); if (i < 0) return null;
  const x = a[i]!; return /^--execute=/.test(x) ? x.slice(10) : /^-e./.test(x) ? x.slice(2) : a[i + 1] || '';
}

function classifySegment(seg: string): CommandClass {
  if (hasWriteRedirect(seg)) return 'change';
  const w = words(seg); if (!w.length) return 'read';
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) { w.shift(); if (!w.length) return 'read'; }   // VAR=nilai di depan
  if (w[0] === 'sudo') { w.shift(); while (w[0] && /^-(n|E|H|S)$/.test(w[0])) w.shift(); if (/^-[ugCrtph]$|^--/.test(w[0] || '')) return 'change'; }
  const cmd = (w[0] || '').replace(/^.*\//, ''), args = w.slice(1);
  if (!READ_CMDS.has(cmd)) return 'change';
  if (['timeout', 'time', 'nice', 'ionice'].includes(cmd)) { const rest = args.filter((x) => !(x[0] === '-' || /^\d+[smhd]?$/.test(x))); return rest.length ? classifySegment(rest.join(' ')) : 'read'; }
  if (cmd === 'mysql' || cmd === 'mariadb') { const s = sqlOfArgs(args); return s != null && sqlIsRead(s) ? 'read' : 'change'; }
  if (cmd === 'mysqladmin') return args.some((x) => /^(status|ping|processlist|extended-status|variables|version)$/.test(x)) && !args.some((x) => /^(shutdown|kill|flush|drop|create|reload|refresh|stop-slave|start-slave)/.test(x)) ? 'read' : 'change';
  if (cmd === 'psql') { const i = args.findIndex((x) => x === '-c' || x === '--command'); return i >= 0 && sqlIsRead(args[i + 1] || '') ? 'read' : 'change'; }
  if (cmd === 'redis-cli') {
    const verbs = args.filter((x) => x[0] !== '-'), v0 = verbs[0] || '';
    const simple = /^(info|ping|dbsize|slowlog|latency|memory|client|ttl|type|exists|get|scan|keys|llen|hlen|zcard|scard|strlen|lrange|hget|hgetall|smembers|time|lastsave)$/i.test(v0);
    return simple || (/^config$/i.test(v0) && /^get$/i.test(verbs[1] || '')) ? 'read' : 'change';
  }
  const f = READ_SUB[cmd]; if (f && !f(args)) return 'change';
  return 'read';
}

export function classify(command: string): Classification {
  const cmd = String(command || '').trim();
  if (!cmd) return { cls: 'blocked', why: 'Perintah kosong' };
  if (cmd.length > 4000) return { cls: 'blocked', why: 'Perintah terlalu panjang' };
  for (const [re, why] of BLOCKED) if (re.test(cmd)) return { cls: 'blocked', why: 'Diblokir kebijakan: ' + why };
  if (/<<-?\s*['"]?\w+/.test(cmd)) return { cls: 'change', why: 'Memakai heredoc' };
  const inner: string[] = []; let rest = cmd, prev: string;
  do { prev = rest; rest = rest.replace(/\$\(([^()]*)\)/g, (_m, g: string) => { inner.push(g); return ' x '; }).replace(/`([^`]*)`/g, (_m, g: string) => { inner.push(g); return ' x '; }); } while (rest !== prev);
  const parts = splitSegments(rest); for (const g of inner) for (const p of splitSegments(g)) parts.push(p);
  for (const p of parts) if (classifySegment(p) !== 'read') return { cls: 'change', why: 'Mengubah sesuatu atau perintah tidak dikenal: ' + p.slice(0, 80) };
  return { cls: 'read', why: 'Hanya membaca' };
}

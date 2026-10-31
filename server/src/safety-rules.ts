// Aturan per perintah untuk kebijakan baca-saja (safety.ts). Prinsip: bentuk yang tidak dikenali dianggap MENGUBAH (perlu persetujuan), bukan baca.
// Perintah "baca" jalan otomatis tanpa persetujuan, jadi tiap perintah di sini hanya lolos bila SELURUH argumennya sudah dikenal aman. Audit keamanan
// menemukan perintah baca yang ternyata menulis berkas (sort -o, uniq in out, curl -D), mengeksekusi (sed e, awk print | sh), atau mengubah sistem (date -s, hostname X).

// ---------- sed: hanya skrip dari perintah yang dikenal; tanpa e/w/r/R/W, tanpa flag s///e atau s///w, tanpa -i/-f
const SED_SIMPLE = new Set(['p', 'd', 'D', 'P', 'n', 'N', 'q', 'Q', '=', 'l', 'g', 'G', 'h', 'H', 'x']);
const SED_FLAGS = /^[gGpPiImM0-9]*/;

/** Membaca satu bagian yang diakhiri pembatas `d` (dengan \ untuk lolos dan [...] literal). Mengembalikan indeks setelah pembatas, atau -1. */
function sedPart(s: string, i: number, d: string): number {
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') { i++; continue; }
    if (c === '[') { const end = s.indexOf(']', i + 2); if (end < 0) return -1; i = end; continue; }
    if (c === d) return i + 1;
    if (c === '\n') return -1;
  }
  return -1;
}
function sedAddress(s: string, i: number): number {
  const m = /^(\d+(~\d+)?|\$)/.exec(s.slice(i)); if (m) return i + m[0].length;
  if (s[i] === '/' || s[i] === '\\') { const d = s[i] === '\\' ? s[i + 1] : '/'; if (!d || /[\s\\]/.test(d)) return -1; const e = sedPart(s, i + (s[i] === '\\' ? 2 : 1), d); if (e < 0) return -1; const f = /^[IM]*/.exec(s.slice(e))![0]; return e + f.length; }
  return i;
}
export function sedScriptSafe(s: string): boolean {
  let i = 0; const n = s.length;
  while (i < n) {
    while (i < n && /[\s;]/.test(s[i]!)) i++;
    if (i >= n) break;
    if (s[i] === '#') { while (i < n && s[i] !== '\n') i++; continue; }
    if (s[i] === '}' ) { i++; continue; }
    let j = sedAddress(s, i); if (j < 0) return false;
    if (j > i && s[j] === ',') { const k = sedAddress(s, j + 1); if (k < 0 || k === j + 1) return false; j = k; }
    while (s[j] === ' ') j++;
    if (s[j] === '!') { j++; while (s[j] === ' ') j++; }
    const c = s[j]; if (c === undefined) return false;
    if (c === '{') { i = j + 1; continue; }
    if (SED_SIMPLE.has(c)) { i = j + 1; if (c === 'q' || c === 'Q' || c === 'l') { while (/\d/.test(s[i] ?? '')) i++; } continue; }
    if (c === 's') {
      const d = s[j + 1]; if (!d || /[\s\\]/.test(d)) return false;
      const e1 = sedPart(s, j + 2, d); if (e1 < 0) return false; const e2 = sedPart(s, e1, d); if (e2 < 0) return false;
      const flags = SED_FLAGS.exec(s.slice(e2))![0]; i = e2 + flags.length;
      if (i < n && !/[\s;}#]/.test(s[i]!)) return false;   // flag lain (e, w, ...): tidak dikenal
      continue;
    }
    if (c === 'y') {
      const d = s[j + 1]; if (!d || /[\s\\]/.test(d)) return false;
      const e1 = sedPart(s, j + 2, d); if (e1 < 0) return false; const e2 = sedPart(s, e1, d); if (e2 < 0) return false; i = e2;
      if (i < n && !/[\s;}#]/.test(s[i]!)) return false; continue;
    }
    return false;   // a, i, c, e, r, R, w, W, b, t, T, :, v, z, F, ...
  }
  return true;
}
/** Argumen sed (setelah nama perintah): hanya opsi tampilan, skrip yang aman, dan nama berkas. */
export function sedSafe(a: string[]): boolean {
  const scripts: string[] = []; let i = 0, haveE = false;
  for (; i < a.length; i++) {
    const x = a[i]!;
    if (x === '--') { i++; break; }
    if (/^--(quiet|silent|regexp-extended|separate|null-data|unbuffered|posix|debug|sandbox)$/.test(x)) continue;
    if (x === '--expression') { if (a[i + 1] === undefined) return false; scripts.push(a[++i]!); haveE = true; continue; }
    if (x.startsWith('--expression=')) { scripts.push(x.slice(13)); haveE = true; continue; }
    if (x.startsWith('--')) return false;   // --in-place, --in-place=.bak, --file, --follow-symlinks, ...
    if (x.length > 1 && x[0] === '-') {
      for (let k = 1; k < x.length; k++) {
        const c = x[k]!;
        if ('nErszu'.includes(c)) continue;
        if (c === 'e') { const rest = x.slice(k + 1); if (rest) scripts.push(rest); else { if (a[i + 1] === undefined) return false; scripts.push(a[++i]!); } haveE = true; break; }
        return false;   // -i, -f, -l, -b, ...
      }
      continue;
    }
    break;
  }
  if (!haveE) { if (a[i] === undefined) return false; scripts.push(a[i]!); i++; }
  if (a.slice(i).some((x) => x.length > 1 && x[0] === '-')) return false;   // opsi sesudah skrip (mis. -i di belakang)
  return scripts.length > 0 && scripts.every(sedScriptSafe);
}

// ---------- awk: tanpa system(), getline, -f/-i, dan tanpa print/printf yang diarahkan ke berkas atau pipa
export function awkSafe(a: string[]): boolean {
  let prog: string | null = null;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (prog !== null) { if (x.length > 1 && x[0] === '-') return false; continue; }   // sesudah program hanya nama berkas
    if (x === '--') continue;
    if (x === '-F' || x === '-v') { if (a[i + 1] === undefined) return false; i++; continue; }
    if (/^-F./.test(x) || /^-v./.test(x)) continue;
    if (x.length > 1 && x[0] === '-') return false;   // -f, -i, -e, -E, -l, --exec, --include, ...
    prog = x;
  }
  if (prog === null) return false;
  if (/\bsystem\s*\(|\bgetline\b|@(load|include|namespace)\b/.test(prog)) return false;
  if (/\bprint[f]?\b[^;}]*?(>>?|\|)/.test(prog)) return false;   // print > "berkas", print | "perintah", print |& "perintah" (juga bila ada baris baru di antaranya)
  return true;
}

// ---------- curl: hanya opsi yang dikenal aman; apa pun yang menulis berkas atau mengirim data diperlakukan sebagai perubahan
const CURL_BOOL = /^-[sSfiIkv]+$|^--(silent|show-error|fail|head|insecure|include|verbose|compressed|http1\.1|ipv4|ipv6|no-keepalive)$/;
const CURL_ARG = new Set(['-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-H', '--header', '-A', '--user-agent', '--retry', '--retry-delay']);
export function curlSafe(a: string[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x[0] !== '-' || x === '-') continue;   // URL
    if (CURL_BOOL.test(x)) continue;
    if (x === '-o' || x === '--output') { if (a[++i] !== '/dev/null') return false; continue; }
    if (x === '--output=/dev/null') continue;
    if (CURL_ARG.has(x)) { if (a[++i] === undefined) return false; continue; }
    return false;   // -D, -c, -b, -K, -T, -d, -F, -X, -O, --remote-name, --json, --trace, --stderr, --libcurl, ...
  }
  return true;
}

// ---------- perintah informasi yang punya mode mengubah
export function dateSafe(a: string[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x.startsWith('+') || /^-[uRI]+$/.test(x) || /^--(utc|universal|rfc-email|rfc-3339=.*|iso-8601(=.*)?|date=.*|reference=.*)$/.test(x)) continue;
    if (x === '-d' || x === '--date' || x === '-r' || x === '--reference') { if (a[++i] === undefined) return false; continue; }
    return false;   // -s/--set, tanggal posisional (mengatur jam), dan lainnya
  }
  return true;
}
export const hostnameSafe = (a: string[]): boolean => a.every((x) => /^-[fsiIdAayv]+$/.test(x) || /^--(fqdn|short|ip-address|all-ip-addresses|domain|alias|yp|nis|long)$/.test(x));
export const hostnamectlSafe = (a: string[]): boolean => a.every((x) => /^(status|--no-pager|-j|--json=.*)$/.test(x));
export const dmesgSafe = (a: string[]): boolean => !a.some((x) => /^-[a-zA-Z]*[cCnDE]/.test(x) || /^--(clear|read-clear|console-level|console-off|console-on)/.test(x));
export function sortSafe(a: string[]): boolean { return !a.some((x) => /^-[a-zA-Z]*o/.test(x) || /^--(output|compress-program)(=|$)/.test(x)); }
/** uniq [opsi] [masukan [keluaran]]: argumen posisional kedua adalah berkas KELUARAN. */
export function uniqSafe(a: string[]): boolean {
  let pos = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]!; if (x === '-f' || x === '-s' || x === '-w') { i++; continue; } if (x.length > 1 && x[0] === '-') continue; pos++; }
  return pos <= 1;
}

// ---------- berkas rahasia: perintah baca tidak boleh membacanya tanpa persetujuan (isinya akan masuk ke keluaran, log, dan prompt model)
const SENSITIVE: RegExp[] = [
  /(^|\/)etc\/(shadow|gshadow)(-|\.bak)?$/, /(^|\/)etc\/mysql\/debian\.cnf$/, /(^|\/)etc\/ssl\/private(\/|$)/, /(^|\/)etc\/letsencrypt\/(live|archive)\/.*privkey/,
  /(^|\/)\.ssh\/id_[A-Za-z0-9_-]*$/, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/, /\.(pem|key|p12|pfx|jks|keystore)$/,
  /(^|\/)proc\/(\d+|self|thread-self)\/environ$/, /(^|\/)(var\/)?run\/secrets(\/|$)/, /(^|\/)\.aws\/credentials$/, /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.(pgpass|my\.cnf|netrc|git-credentials|npmrc|pypirc)$/, /(^|\/)\.env(\.(?!example$|sample$|dist$|template$)[^/]*)?$/
];
export function sensitivePath(arg: string): boolean { const p = arg.replace(/^["']|["']$/g, '').replace(/\/+/g, '/'); return SENSITIVE.some((re) => re.test(p)); }
/** Perintah yang membaca ISI berkas yang disebut di argumennya. */
export const CONTENT_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'tac', 'nl', 'cut', 'sort', 'uniq', 'grep', 'egrep', 'fgrep', 'awk', 'sed', 'column', 'file', 'wc', 'md5sum', 'sha256sum', 'sed', 'tee']);
/** Pembaca murni berkas (semua argumen bukan-opsi adalah berkas): pola glob di folder sensitif tidak boleh lolos. */
const PURE_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'tac', 'nl', 'cut', 'sort', 'uniq', 'column', 'md5sum', 'sha256sum']);
const GLOB_DIRS = /^(~|\/root|\/home|\/etc\/(s|g|ssl|ssh|letsencrypt|mysql)|\/run|\/var\/run|\/proc)/;
export function readsSensitive(cmd: string, args: string[]): boolean {
  if (!CONTENT_READERS.has(cmd)) return false;
  for (const a of args) {
    if (sensitivePath(a)) return true;
    if (a[0] === '-' || !/[*?[{]/.test(a)) continue;
    // pola glob: diperluas dulu (* -> 1) lalu dicocokkan ke daftar rahasia, supaya /proc/*/environ, /home/*/.ssh/id_*, dan /srv/*/.env tertangkap
    if (sensitivePath(a.replace(/\[[^\]]*\]|\{[^}]*\}|[*?]/g, '1'))) return true;
    // glob pada NAMA berkas ujung (cat /etc/sh*, cat /run/secrets/*) di folder sensitif; glob di tengah dengan nama berkas tetap yang tidak rahasia (authorized_keys) dibiarkan
    if (PURE_READERS.has(cmd) && /[*?[{]/.test(a.split('/').pop() ?? '') && GLOB_DIRS.test(a)) return true;
  }
  return false;
}

// ---------- SQL: fungsi dan bentuk SELECT yang tetap berefek samping
const SQL_SIDE_EFFECT = /(^|[^a-z0-9_])(pg_sleep(_for|_until)?|nextval|setval|lo_import|lo_export|lo_unlink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|set_config|dblink\w*|load_file|get_lock|release_lock|master_pos_wait)\s*\(/i;
export function sqlHasSideEffect(sql: string): boolean {
  return SQL_SIDE_EFFECT.test(sql) || /\binto\s+(?!@)/i.test(sql) || /\bexplain\s*(\([^)]*\banalyze\b|\banalyze\b)/i.test(sql);   // SELECT ... INTO tabel, EXPLAIN ANALYZE (menjalankan pernyataannya)
}

// ---------- alat jaringan: nama yang dihitung dari berkas atau variabel bisa dipakai membocorkan data lewat DNS
const NETWORK = /^\s*([A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(sudo\s+(-\S+\s+)*)?(timeout\s+\S+\s+)?(ping|dig|nslookup|host|traceroute|mtr|tracepath|curl)\s/;
/** Satu segmen perintah (hasil splitSegments pada teks ASLI, sebelum substitusi diganti). */
export function networkWithExpansion(segment: string): boolean {
  if (!NETWORK.test(segment)) return false;
  return /[$`]/.test(segment.replace(/'[^']*'/g, ''));   // di dalam tanda kutip tunggal tidak ada ekspansi
}

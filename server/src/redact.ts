// Menyamarkan rahasia pada keluaran perintah sebelum disimpan di database dan sebelum dikirim ke model.
// Perintah seperti `cat .env` atau `env` bisa menaruh password server di keluaran; di sini nilainya diganti, nama kuncinya tetap.
const MASK = '***';
const KEY_WORDS = String.raw`(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth(?:orization)?|dsn|salt)`;

const PEM = /-----BEGIN ([A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?(?:-----END \1-----|$)/g;
const URL_CRED = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// nama=nilai, nama: nilai, "nama": "nilai" (nama boleh berawalan/berakhiran, mis. DB_PASSWORD, mysql_root_password, aws_secret_access_key)
const KEY_VALUE = new RegExp(String.raw`(["']?[\w.-]*${KEY_WORDS}[\w.-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)`, 'gi');
// opsi baris perintah: --password=x, --password x, -p<x> untuk mysql
const CLI_FLAG = new RegExp(String.raw`(--[\w-]*${KEY_WORDS}[\w-]*(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s"']+)`, 'gi');
const MYSQL_P = /(\bmysql(?:dump|admin)?\b[^\n]*?\s-p)\S+/gi;
// token berformat dikenal
const KNOWN = [
  /\bAKIA[0-9A-Z]{16}\b/g, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
];

export function redactOutput(text: string | null | undefined): string {
  if (!text) return '';
  let t = String(text).replace(PEM, `-----BEGIN PRIVATE KEY-----\n${MASK}\n-----END PRIVATE KEY-----`);
  t = t.replace(URL_CRED, `$1${MASK}@`).replace(BEARER, `$1 ${MASK}`);
  t = t.replace(KEY_VALUE, `$1${MASK}`).replace(CLI_FLAG, `$1${MASK}`).replace(MYSQL_P, `$1${MASK}`);
  for (const re of KNOWN) t = t.replace(re, MASK);
  return t;
}

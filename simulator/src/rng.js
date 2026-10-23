// Pengacak berbenih. Mesin simulasi memakai Math.random (kedatangan request, jitter waktu); dengan benih, masukan yang sama selalu menghasilkan hasil yang sama.
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function seedOf(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Jalankan fn dengan Math.random berbenih, lalu kembalikan yang asli (juga bila fn melempar galat). */
function withSeed(seed, fn) {
  const real = Math.random; Math.random = mulberry32(typeof seed === 'number' ? seed : seedOf(String(seed)));
  try { return fn(); } finally { Math.random = real; }
}

module.exports = { mulberry32: mulberry32, seedOf: seedOf, withSeed: withSeed };

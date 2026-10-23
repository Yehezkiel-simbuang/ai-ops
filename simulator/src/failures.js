// Skenario kegagalan: "matikan node X pada detik T selama S detik" diterjemahkan menjadi gangguan mesin, menurut apa yang dimiliki node itu.
//   expand(arch, { node, at, len }) -> { faults, label, skipped? }
// Akibat berbeda tergantung ketahanan arsitektur: server tunggal mati total; beberapa server di belakang load balancer hanya kehilangan 1/N kapasitas
// (plus request yang masuk ke server mati sampai health check mendeteksinya); database HA hanya terganggu selama failover lalu lambat sesaat (cache dingin).
const FOREVER = 1e6;          // len 0 = sampai akhir simulasi
const COLD_CACHE_MULT = 3;    // setelah failover, standby memulai dengan cache dingin: layanan database sementara 3x lebih lambat

const label = function (n) { return n.label || n.id; };

function expand(arch, failure) {
  const n = arch.nodes.find(function (x) { return x.id === failure.node; });
  if (!n) return { faults: [], label: failure.node, skipped: 'Node ' + failure.node + ' tidak ada di arsitektur ini.' };
  const at = Math.max(0, failure.at || 0), len = failure.len > 0 ? failure.len : FOREVER, out = { faults: [], label: label(n) };
  if (n.type === 'pool') {
    const N = n.instances || 1;
    if (N > 1) out.faults.push({ node: n.id, type: 'capacity', at: at, len: len, keep: (N - 1) / N, blackhole: 1 / N, detectS: n.detectS || 10, tag: 'degraded' });
    else out.faults.push({ node: n.id, type: 'down', at: at, len: len, tag: 'down' });
  } else if (n.type === 'db') {
    const ha = n.ha;
    if (ha) {
      const down = Math.min(len, ha.failoverS);
      out.faults.push({ node: n.id, type: 'down', at: at, len: down, tag: 'failover' });
      if (len > ha.failoverS && ha.warmS > 0) out.faults.push({ node: n.id, type: 'slow', at: at + ha.failoverS, len: Math.min(ha.warmS, len - ha.failoverS), mult: COLD_CACHE_MULT, tag: 'warm' });
    } else out.faults.push({ node: n.id, type: 'down', at: at, len: len, tag: 'down' });
  } else if (n.type === 'cache' || n.type === 'external') out.faults.push({ node: n.id, type: 'down', at: at, len: len, tag: 'down' });
  else if (n.type === 'disk') out.faults.push({ node: n.id, type: 'stall', at: at, len: len, tag: 'down' });
  else return { faults: [], label: label(n), skipped: label(n) + ' (' + n.type + ') tidak bisa dimatikan di simulasi ini.' };
  return out;
}

/** Keadaan visual tiap node pada detik t: 'down' | 'failover' | 'degraded' | 'warm' (hanya dari gangguan hasil expand). */
function statesAt(faults, t) {
  const s = {};
  faults.forEach(function (f) { if (f.tag && f.at != null && t >= f.at && t < f.at + (f.len == null ? FOREVER : f.len)) s[f.node] = f.tag; });
  return s;
}

module.exports = { expand: expand, statesAt: statesAt, FOREVER: FOREVER };

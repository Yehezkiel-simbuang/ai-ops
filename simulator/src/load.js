// Model beban trafik yang umum untuk arsitektur apa pun: pengguna aktif x RPM per pengguna = total RPM,
// dibagi ke jenis request menurut bobot campuran, dikalikan profil lonjakan yang berubah menurut waktu.
// Dipakai di browser (lab) dan Node (benchmark).
const Load = (function () {
  const SPIKE_DEFAULT = { on: false, mult: 4, at: 15, len: 45, every: 0, shape: 'step' };

  // yang ikut campuran beban pengguna: request sinkron, dan pekerjaan yang dipindah ke antrean (w.mixed) tapi tetap dipicu pengguna
  function syncOf(arch) { return arch.workloads.filter(function (w) { return !w.async || w.mixed; }); }
  function baseRps(arch) { return syncOf(arch).reduce(function (s, w) { return s + (w.rate || 0); }, 0); }

  // nilai awal dari laju yang ada di arsitektur: total RPM sama, dipecah menjadi pengguna x RPM per pengguna
  function defaults(arch) {
    const rpm = baseRps(arch) * 60, rpu = rpm >= 6 ? 6 : Math.max(0.1, +rpm.toFixed(2)), users = Math.max(1, Math.round(rpm / rpu));
    const mix = {}, tot = baseRps(arch) || 1;
    syncOf(arch).forEach(function (w) { mix[w.id] = +(100 * (w.rate || 0) / tot).toFixed(1); });
    return { users: users, rpu: rpu, mix: mix, spike: Object.assign({}, SPIKE_DEFAULT) };
  }
  function totalRpm(load) { return load.users * load.rpu; }

  // pengali lonjakan pada detik t (1 = normal)
  function factor(sp, t) {
    if (!sp || !sp.on || !(sp.mult > 0)) return 1;
    let x = t - sp.at; if (x < 0) return 1;
    if (sp.every > 0) x = x % sp.every;
    if (x > sp.len) return 1;
    if (sp.shape === 'tri') { const h = sp.len / 2 || 1; return 1 + (sp.mult - 1) * (x <= h ? x / h : (sp.len - x) / h); }
    return sp.mult;
  }

  // laju (request/detik) tiap workload pada detik t. edits: laju mutlak untuk workload latar; mul: pengali per workload (mis. skenario "request berat")
  function rates(arch, load, t, edits, mul) {
    const out = {}, f = factor(load.spike, t), total = totalRpm(load) / 60, sync = syncOf(arch);
    let wsum = 0; sync.forEach(function (w) { wsum += load.mix[w.id] != null ? load.mix[w.id] : 0; });
    arch.workloads.forEach(function (w) {
      const m = (mul && mul[w.id]) || 1;
      if (w.async && !w.mixed) out[w.id] = edits && edits[w.id] != null ? edits[w.id] : (w.rate || 0) * m;
      else out[w.id] = wsum > 0 ? total * ((load.mix[w.id] || 0) / wsum) * m * f * (1 - (w.cdn || 0)) * (1 - (w.shed || 0)) : 0;   // w.cdn: porsi yang dilayani CDN dan tidak sampai ke origin
    });
    // batas laju filter (rate limit): kelebihan di atas batas dibuang, bukan ditunda
    const limiter = arch.nodes.find(function (n) { return n.id === 'x-filter' && n.limitRps > 0; });
    if (limiter) {
      let sum = 0; sync.forEach(function (w) { sum += out[w.id] || 0; });
      if (sum > limiter.limitRps) sync.forEach(function (w) { out[w.id] = (out[w.id] || 0) * limiter.limitRps / sum; });
    }
    return out;
  }
  return { defaults: defaults, factor: factor, rates: rates, totalRpm: totalRpm, SPIKE_DEFAULT: SPIKE_DEFAULT };
})();
if (typeof module !== 'undefined') { module.exports = Load; }

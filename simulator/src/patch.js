// Menerapkan patch (daftar operasi) ke sebuah arsitektur. Dipakai oleh rekomendasi dan lab.
// Patch tidak mengubah objek asli; hasilnya salinan baru.
const Patch = (function () {
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function match(id, pat) { return pat.endsWith('*') ? id.startsWith(pat.slice(0, -1)) : id === pat; }
  function matchAny(id, pats) { return (Array.isArray(pats) ? pats : [pats]).some(function (p) { return match(id, p); }); }

  // Operasi:
  //  {op:'node', id, set:{...}}                       ubah properti node
  //  {op:'workload', id, set:{...}}                   ubah properti workload (pola id boleh berakhiran *)
  //  {op:'call', workload, tag|node, set:{...}, mul:{read:0.2}}  ubah panggilan di workload
  //  {op:'addNode', node:{...}}
  //  {op:'splitPool', id, into:[{id,label,workers,workloads:[pola]}]}
  function apply(arch, ops) {
    const a = clone(arch);
    (ops || []).forEach(function (op) {
      if (op.op === 'node') {
        const n = a.nodes.find(function (x) { return x.id === op.id; });
        if (n) Object.assign(n, op.set);
      } else if (op.op === 'workload') {
        a.workloads.forEach(function (w) { if (matchAny(w.id, op.id)) Object.assign(w, op.set); });
      } else if (op.op === 'call') {
        a.workloads.forEach(function (w) {
          if (!matchAny(w.id, op.workload)) return;
          (w.calls || []).forEach(function (c) {
            if ((op.tag && c.tag === op.tag) || (op.node && c.node === op.node)) {
              if (op.set) Object.assign(c, op.set);
              if (op.mul) Object.keys(op.mul).forEach(function (k) { if (typeof c[k] === 'number') c[k] = c[k] * op.mul[k]; });
            }
          });
        });
      } else if (op.op === 'addNode') {
        if (!a.nodes.some(function (x) { return x.id === op.node.id; })) a.nodes.push(clone(op.node));
      } else if (op.op === 'splitPool') {
        const i = a.nodes.findIndex(function (x) { return x.id === op.id; });
        if (i < 0) return;
        const base = a.nodes[i];
        const parts = op.into.map(function (p) { return Object.assign({}, base, { id: p.id, label: p.label || base.label, workers: p.workers }); });
        a.nodes.splice.apply(a.nodes, [i, 1].concat(parts));
        op.into.forEach(function (p) {
          a.workloads.forEach(function (w) { if (w.pool === op.id && matchAny(w.id, p.workloads)) w.pool = p.id; });
        });
        a.workloads.forEach(function (w) { if (w.pool === op.id) w.pool = op.into[0].id; });
      }
    });
    return a;
  }
  return { apply: apply, clone: clone, match: match };
})();
if (typeof module !== 'undefined') module.exports = Patch;

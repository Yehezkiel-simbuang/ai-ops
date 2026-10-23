// Pintu masuk analyzer multi-tumpukan. Laravel tetap memakai jalur khusus yang lebih dalam (tools/analyze.js).
const path = require('path');
const S = require('./scan.js');
const Infra = require('./infra.js');
const Stacks = require('./stacks.js');
const Build = require('./build.js');

function analyzeGeneric(root) {
  const infra = Infra.scanInfra(root), units = Stacks.findUnits(root), facts = [];
  units.forEach(function (u) { const r = Stacks.detect(u, root, infra); if (r && r.facts) facts.push(r.facts); });
  const env = S.parseEnv(root);
  const arch = Build.build(root, facts, infra, env);
  return { arch: arch, facts: { stack: facts.map(function (f) { return f.name; }).join(' + ') || 'tidak dikenal', kind: facts.length ? facts[0].stack : 'unknown', units: facts, infra: { evidence: infra.evidence, proxy: infra.proxy, hints: infra.hints, replicas: infra.replicas, services: infra.services.map(function (s) { return s.name + (s.kind ? ':' + s.kind : ''); }) } } };
}
module.exports = { analyzeGeneric: analyzeGeneric };

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

// Skrip k6 bersifat TETAP: data pengguna (target, request, header) dikirim lewat variabel lingkungan sebagai JSON,
// tidak pernah disisipkan ke dalam kode JavaScript, jadi tidak ada injeksi skrip.
const k6Script = `import http from 'k6/http';
import { sleep } from 'k6';

const TARGET = __ENV.TARGET;
const THINK = Number(__ENV.THINK || 0);
const HEADERS = JSON.parse(__ENV.HEADERS || '{}');
const REQS = JSON.parse(__ENV.REQS || '[]');
const TOTAL = REQS.reduce((s, r) => s + r.weight, 0);

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }));
export const options = { summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'] };

export default function () {
  let u = Math.random() * TOTAL, r = REQS[REQS.length - 1];
  for (const x of REQS) { u -= x.weight; if (u <= 0) { r = x; break; } }
  const headers = Object.assign({ 'Content-Type': r.body ? 'application/json' : 'text/plain' }, HEADERS);
  http.request(r.method, TARGET + r.path, r.body || null, { headers: headers, tags: { name: r.name } });
  if (THINK > 0) sleep(THINK * (0.5 + Math.random()));
}
`

func writeScript(dir string) (string, error) {
	p := filepath.Join(dir, "scenario.js")
	return p, os.WriteFile(p, []byte(k6Script), 0o600)
}

// k6Env menyusun variabel lingkungan untuk satu tahap.
func k6Env(j *Job) ([]string, error) {
	reqs, err := json.Marshal(j.Requests)
	if err != nil {
		return nil, err
	}
	hdrs, err := json.Marshal(j.Headers)
	if err != nil {
		return nil, err
	}
	return []string{"TARGET=" + j.Target, "THINK=" + strconv.FormatFloat(j.ThinkSeconds, 'f', -1, 64), "HEADERS=" + string(hdrs), "REQS=" + string(reqs)}, nil
}

// k6Args: jumlah pengguna dan durasi lewat argumen, bukan di dalam skrip.
func k6Args(script, summary string, s Stage) []string {
	return []string{"run", "--quiet", "--no-usage-report", "--vus", strconv.Itoa(s.VUs), "--duration", strconv.Itoa(s.Seconds) + "s", "--summary-export", summary, script}
}

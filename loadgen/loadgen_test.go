package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestReadMetricPrometheus(t *testing.T) {
	body := []byte(`# HELP x
# TYPE node_load1 gauge
node_load1 2.5
node_cpu_seconds_total{cpu="0",mode="idle"} 10
node_cpu_seconds_total{cpu="1",mode="idle"} 20
demo_db_pool_in_use 7
demo_db_pool_in_use_max 99
`)
	cases := []struct {
		m    string
		want float64
		ok   bool
	}{{"node_load1", 2.5, true}, {"node_cpu_seconds_total", 30, true}, {"demo_db_pool_in_use", 7, true}, {"tidak_ada", 0, false}, {"node_load", 0, false}}
	for _, c := range cases {
		got, ok := readMetric(body, c.m)
		if ok != c.ok || got != c.want {
			t.Errorf("%s: got %v,%v want %v,%v", c.m, got, ok, c.want, c.ok)
		}
	}
}

func TestReadMetricJSON(t *testing.T) {
	body := []byte(`{"pool":{"inUse":4,"size":8},"ok":true,"name":"x"}`)
	if v, ok := readMetric(body, "pool.inUse"); !ok || v != 4 {
		t.Errorf("pool.inUse: %v %v", v, ok)
	}
	if v, ok := readMetric(body, "ok"); !ok || v != 1 {
		t.Errorf("ok: %v %v", v, ok)
	}
	for _, m := range []string{"pool.nope", "name", "pool.inUse.x", "x.y"} {
		if _, ok := readMetric(body, m); ok {
			t.Errorf("%s seharusnya tidak terbaca", m)
		}
	}
}

func TestParseSummaryBothFormats(t *testing.T) {
	old := `{"metrics":{"http_req_duration":{"med":40,"p(95)":120.5,"p(99)":300,"max":900},"http_reqs":{"count":600,"rate":20},"http_req_failed":{"value":0.025}}}`
	nw := `{"metrics":{"http_req_duration":{"values":{"med":40,"p(95)":120.5,"p(99)":300}},"http_reqs":{"values":{"count":600,"rate":20}},"http_req_failed":{"values":{"rate":0.025}}}}`
	for name, raw := range map[string]string{"lama": old, "baru": nw} {
		s, err := parseSummary([]byte(raw))
		if err != nil || s.Reqs != 600 || s.RPS != 20 || s.P50 != 40 || s.P95 != 120.5 || s.P99 != 300 || s.ErrPct != 2.5 {
			t.Errorf("%s: %+v %v", name, s, err)
		}
	}
	if _, err := parseSummary([]byte(`{"metrics":{}}`)); err == nil || !strings.Contains(err.Error(), "http_req_duration") {
		t.Errorf("tanpa durasi harus galat jelas: %v", err)
	}
	if _, err := parseSummary([]byte(`bukan json`)); err == nil {
		t.Error("JSON rusak harus galat")
	}
}

func fixed(m map[string][]string) resolver {
	return func(h string) ([]net.IP, error) {
		v, ok := m[h]
		if !ok {
			return nil, fmt.Errorf("no such host")
		}
		var out []net.IP
		for _, s := range v {
			out = append(out, net.ParseIP(s))
		}
		return out, nil
	}
}

func TestCheckURL(t *testing.T) {
	res := fixed(map[string][]string{"staging": {"10.0.0.5"}, "campur": {"10.0.0.5", "8.8.8.8"}, "publik.contoh.com": {"93.184.216.34"}})
	ok := []string{"http://10.0.0.5:8080", "http://127.0.0.1:4317", "http://[::1]:8080", "http://192.168.1.2", "http://172.20.0.3", "http://staging:8080"}
	for _, u := range ok {
		if err := checkURL(u, false, res); err != nil {
			t.Errorf("%s harus lolos: %v", u, err)
		}
	}
	bad := []string{"http://8.8.8.8", "http://campur", "http://publik.contoh.com", "http://tidak-ada", "ftp://10.0.0.5", "http://", "bukan url", "http://172.32.0.1"}
	for _, u := range bad {
		if err := checkURL(u, false, res); err == nil {
			t.Errorf("%s harus ditolak", u)
		}
	}
	if err := checkURL("https://publik.contoh.com", true, res); err != nil {
		t.Errorf("host yang didaftarkan harus lolos: %v", err)
	}
	if err := checkURL("ftp://publik.contoh.com", true, res); err == nil {
		t.Error("skema salah tetap ditolak walau didaftarkan")
	}
	j := &Job{Target: "http://staging:8080", Scrape: []Scrape{{Label: "a", URL: "http://campur/metrics"}}}
	if err := checkJob(j, res); err == nil || !strings.Contains(err.Error(), `"a"`) {
		t.Errorf("alamat metrik publik harus ditolak dengan nama labelnya: %v", err)
	}
}

type fakeCPU struct {
	use   []float64
	i     int
	cpus_ float64
}

func (f *fakeCPU) usageSeconds() (float64, bool) {
	if f.i >= len(f.use) {
		return 0, false
	}
	v := f.use[f.i]
	f.i++
	return v, true
}
func (f *fakeCPU) cpus() float64 { return f.cpus_ }

func TestCPUMeter(t *testing.T) {
	clock := time.Unix(1000, 0)
	m := newCPUMeter(&fakeCPU{use: []float64{10, 25}, cpus_: 2})
	m.now = func() time.Time { return clock }
	m.start()
	clock = clock.Add(10 * time.Second) // 15 detik CPU dalam 10 detik pada 2 core = 75%
	if u := m.stop(); u < 0.749 || u > 0.751 {
		t.Errorf("harus 0,75: %v", u)
	}
	m2 := newCPUMeter(&fakeCPU{use: []float64{0, 100}, cpus_: 1})
	m2.now = func() time.Time { return clock }
	m2.start()
	clock = clock.Add(time.Second)
	if u := m2.stop(); u != 1 {
		t.Errorf("harus dibatasi 1: %v", u)
	}
	m3 := newCPUMeter(&fakeCPU{cpus_: 1}) // tidak bisa membaca
	m3.start()
	if u := m3.stop(); u != 0 {
		t.Errorf("tak terukur = 0: %v", u)
	}
}

func TestCgroupCPUParsing(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "cpu.stat"), []byte("usage_usec 2500000\nuser_usec 1\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "cpu.max"), []byte("150000 100000\n"), 0o600)
	c := cgroupCPU{root: dir}
	if v, ok := c.usageSeconds(); !ok || v != 2.5 {
		t.Errorf("usage: %v %v", v, ok)
	}
	if c.cpus() != 1.5 {
		t.Errorf("cpus: %v", c.cpus())
	}
	os.WriteFile(filepath.Join(dir, "cpu.max"), []byte("max 100000\n"), 0o600)
	if c.cpus() < 1 {
		t.Errorf("tanpa batas harus jumlah core: %v", c.cpus())
	}
	if _, ok := (cgroupCPU{root: filepath.Join(dir, "tidak-ada")}).usageSeconds(); ok {
		t.Error("tanpa cgroup harus tidak terbaca")
	}
}

func TestScriptHasNoUserData(t *testing.T) {
	j := &Job{Target: "http://x", Requests: []Request{{Name: "a", Method: "GET", Path: "/'); evil(); //", Weight: 1}}, Headers: map[string]string{"Authorization": "Bearer ');alert(1);//"}}
	env, err := k6Env(j)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "evil()") || !strings.Contains(joined, "alert(1)") {
		t.Error("data pengguna harus lewat variabel lingkungan")
	}
	if strings.Contains(k6Script, "evil") || strings.Contains(k6Script, "alert") {
		t.Error("skrip harus tetap, tanpa data pengguna")
	}
	args := k6Args("s.js", "o.json", Stage{VUs: 25, Seconds: 30})
	want := []string{"--vus", "25", "--duration", "30s", "--summary-export", "o.json"}
	for _, w := range want {
		if !strings.Contains(strings.Join(args, " "), w) {
			t.Errorf("argumen k6 kurang %s: %v", w, args)
		}
	}
}

func TestScrapeSamples(t *testing.T) {
	var mu sync.Mutex
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n++
		v := n
		mu.Unlock()
		fmt.Fprintf(w, "# TYPE demo gauge\ndemo %d\n", v)
	}))
	defer srv.Close()
	stop := startScrape(context.Background(), []Scrape{{Label: "demo", URL: srv.URL, Metric: "demo"}, {Label: "hilang", URL: srv.URL, Metric: "tidak_ada"}}, 20*time.Millisecond, srv.Client())
	time.Sleep(150 * time.Millisecond)
	got := stop()
	d, ok := got["demo"]
	if !ok || d.Max < 3 || d.Last != d.Max || d.Avg <= 0 || d.Avg > d.Max {
		t.Errorf("ringkasan: %+v", d)
	}
	if _, ok := got["hilang"]; ok {
		t.Error("metrik yang tidak ada tidak boleh muncul")
	}
}

// ---------- runner

type fakeAPI struct {
	mu         sync.Mutex
	stages     []StageReport
	finished   []string
	cancelAt   int // setelah laporan tahap ke-N (1-based), balasan cancel=true; 0 = tidak pernah
	beatCancel bool
}

func (f *fakeAPI) next(context.Context, RunnerInfo, int) (*Job, error) { return nil, nil }
func (f *fakeAPI) stage(_ context.Context, _ int, r StageReport) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stages = append(f.stages, r)
	return f.cancelAt > 0 && len(f.stages) >= f.cancelAt, nil
}
func (f *fakeAPI) heartbeat(context.Context, int) (bool, error) { return f.beatCancel, nil }
func (f *fakeAPI) finish(_ context.Context, _ int, status, msg string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finished = append(f.finished, status+"|"+msg)
	return nil
}

func summaryPath(args []string) string {
	for i, a := range args {
		if a == "--summary-export" {
			return args[i+1]
		}
	}
	return ""
}

func fakeK6(calls *[]string) execFn {
	return func(ctx context.Context, _ string, args, _ []string) (string, error) {
		*calls = append(*calls, strings.Join(args, " "))
		vus := 0
		for i, a := range args {
			if a == "--vus" {
				fmt.Sscan(args[i+1], &vus)
			}
		}
		doc := fmt.Sprintf(`{"metrics":{"http_req_duration":{"med":%d,"p(95)":%d,"p(99)":%d},"http_reqs":{"count":%d,"rate":%d},"http_req_failed":{"value":0}}}`, 10*vus, 20*vus, 30*vus, 100*vus, vus)
		return "", os.WriteFile(summaryPath(args), []byte(doc), 0o600)
	}
}

func newTestRunner(api API, run execFn) *runner {
	r := newRunner(api, "k6")
	r.dir = os.TempDir()
	r.cpu = &fakeCPU{use: []float64{0, 1, 1, 2, 2, 3, 3, 4, 4, 5}, cpus_: 1}
	r.resolve = fixed(map[string][]string{"staging": {"10.0.0.5"}})
	r.run = run
	r.beat = time.Hour
	r.logf = func(string, ...any) {}
	return r
}

func job(stages ...Stage) *Job {
	return &Job{ID: 7, Target: "http://staging:8080", Requests: []Request{{Name: "a", Method: "GET", Path: "/", Weight: 1}}, ThinkSeconds: 1, Stages: stages}
}

func TestRunJobHappyPath(t *testing.T) {
	api, var_ := &fakeAPI{}, []string{}
	r := newTestRunner(api, fakeK6(&var_))
	r.runJob(context.Background(), job(Stage{5, 10}, Stage{20, 10}, Stage{50, 10}))
	if len(api.stages) != 3 || len(api.finished) != 1 || api.finished[0] != "done|" {
		t.Fatalf("hasil: %d tahap, selesai=%v", len(api.stages), api.finished)
	}
	if s := api.stages[1]; s.Idx != 1 || s.VUs != 20 || s.P95 != 400 || s.RPS != 20 || s.Ended < s.Started {
		t.Errorf("tahap 2: %+v", s)
	}
	if len(var_) != 3 || !strings.Contains(var_[2], "--vus 50") {
		t.Errorf("k6 dijalankan per tahap: %v", var_)
	}
}

func TestRunJobCancelFromStageReply(t *testing.T) {
	api, calls := &fakeAPI{cancelAt: 1}, []string{}
	newTestRunner(api, fakeK6(&calls)).runJob(context.Background(), job(Stage{5, 10}, Stage{20, 10}))
	if len(api.stages) != 1 || len(calls) != 1 || !strings.HasPrefix(api.finished[0], "cancelled|") {
		t.Errorf("berhenti setelah tahap 1: tahap=%d k6=%d selesai=%v", len(api.stages), len(calls), api.finished)
	}
}

func TestRunJobCancelMidStage(t *testing.T) {
	api := &fakeAPI{beatCancel: true}
	r := newTestRunner(api, func(ctx context.Context, _ string, _, _ []string) (string, error) {
		<-ctx.Done() // k6 "berjalan lama" sampai dibatalkan
		return "", ctx.Err()
	})
	r.beat = 10 * time.Millisecond
	done := make(chan struct{})
	go func() { r.runJob(context.Background(), job(Stage{5, 60})); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("pembatalan di tengah tahap harus menghentikan k6")
	}
	if len(api.stages) != 0 || len(api.finished) != 1 || !strings.HasPrefix(api.finished[0], "cancelled|") {
		t.Errorf("selesai=%v tahap=%d", api.finished, len(api.stages))
	}
}

func TestRunJobFailures(t *testing.T) {
	// target publik: ditolak sebelum k6 berjalan
	api, calls := &fakeAPI{}, []string{}
	j := job(Stage{5, 10})
	j.Target = "http://8.8.8.8"
	newTestRunner(api, fakeK6(&calls)).runJob(context.Background(), j)
	if len(calls) != 0 || !strings.Contains(api.finished[0], "failed|Target ditolak runner") {
		t.Errorf("target publik: k6=%d selesai=%v", len(calls), api.finished)
	}
	// k6 gagal
	api2 := &fakeAPI{}
	newTestRunner(api2, func(context.Context, string, []string, []string) (string, error) {
		return "boom", fmt.Errorf("exit status 99")
	}).runJob(context.Background(), job(Stage{5, 10}))
	if !strings.Contains(api2.finished[0], "k6 gagal pada tahap 1") || !strings.Contains(api2.finished[0], "boom") {
		t.Errorf("k6 gagal: %v", api2.finished)
	}
	// ringkasan tidak ditulis
	api3 := &fakeAPI{}
	newTestRunner(api3, func(context.Context, string, []string, []string) (string, error) { return "", nil }).runJob(context.Background(), job(Stage{5, 10}))
	if !strings.HasPrefix(api3.finished[0], "failed|tahap 1") {
		t.Errorf("ringkasan hilang: %v", api3.finished)
	}
}

func TestStageReportJSONMatchesServer(t *testing.T) {
	b, _ := json.Marshal(StageReport{Idx: 1, VUs: 5, Seconds: 10, Scraped: map[string]Sampled{"a": {1, 2, 3}}})
	for _, k := range []string{`"idx"`, `"vus"`, `"seconds"`, `"started"`, `"ended"`, `"reqs"`, `"rps"`, `"p50"`, `"p95"`, `"p99"`, `"errPct"`, `"genCpu"`, `"scraped"`} {
		if !strings.Contains(string(b), k) {
			t.Errorf("laporan tahap harus memuat %s (cocok dengan stageReportSchema di server): %s", k, b)
		}
	}
}

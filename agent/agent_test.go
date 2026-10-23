package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- pengganti
type fakeSys struct {
	cores           int
	load, mem, disk float64
	psi             float64
	psiOK           bool
	err             error
}

func (f *fakeSys) Cores() int                      { return f.cores }
func (f *fakeSys) Load5() (float64, error)         { return f.load, f.err }
func (f *fakeSys) MemAvailPct() (float64, error)   { return f.mem, f.err }
func (f *fakeSys) DiskPct(string) (float64, error) { return f.disk, f.err }
func (f *fakeSys) IOPsi() (float64, bool, error)   { return f.psi, f.psiOK, nil }
func (f *fakeSys) UptimeSeconds() (int64, error)   { return 1000, nil }

type fakeRun struct {
	mu   sync.Mutex
	outs map[string]string // substring perintah -> keluaran
	cmds []string
}

func (f *fakeRun) Run(_ context.Context, cmd string, _ time.Duration) (string, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cmds = append(f.cmds, cmd)
	for k, v := range f.outs {
		if strings.Contains(cmd, k) {
			return v, 0, nil
		}
	}
	return "", 0, errors.New("tidak ada")
}

const secret = "0123456789abcdef0123456789abcdef"

func testCfg(t *testing.T, url string) Config {
	c := DefaultConfig()
	c.ServerURL, c.KeyID, c.Secret, c.InsecureHTTP = url, "ak_test", secret, true
	c.StateDir = t.TempDir()
	return c
}
func quiet() *log.Logger { return log.New(io.Discard, "", 0) }

// ---------- server aplikasi tiruan yang memverifikasi tanda tangan
type fakeApp struct {
	*httptest.Server
	mu        sync.Mutex
	events    []Event
	beats     int
	reqBytes  int
	status    int // 0 = normal; selain itu dipakai untuk semua jawaban /events
	badSig    int
	poll      bool
	queue     []Command
	results   map[string]CommandResult
	nowOffset time.Duration

	configJSON    string // jawaban GET /agent/v1/config; bila diisi, detak jantung memberi tahu versinya
	configFetches int
}

func newFakeApp(t *testing.T) *fakeApp {
	f := &fakeApp{results: map[string]CommandResult{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		defer f.mu.Unlock()
		ts := r.Header.Get("X-Aiops-Ts")
		if Sign(secret, ts, r.Method, r.URL.Path, body) != r.Header.Get("X-Aiops-Sig") || r.Header.Get("X-Aiops-Key") != "ak_test" {
			f.badSig++
			w.WriteHeader(401)
			return
		}
		f.reqBytes += len(body)
		switch {
		case r.URL.Path == "/agent/v1/events":
			if f.status != 0 {
				w.WriteHeader(f.status)
				return
			}
			var p struct{ Events []Event }
			_ = json.Unmarshal(body, &p)
			f.events = append(f.events, p.Events...)
			w.Write([]byte(`{"ok":true}`))
		case r.URL.Path == "/agent/v1/heartbeat":
			f.beats++
			resp := map[string]any{"ok": true, "poll": f.poll}
			if f.configJSON != "" {
				var c struct{ Version string }
				_ = json.Unmarshal([]byte(f.configJSON), &c)
				resp["cfg"] = c.Version
			}
			json.NewEncoder(w).Encode(resp)
		case r.URL.Path == "/agent/v1/config":
			f.configFetches++
			w.Write([]byte(f.configJSON))
		case r.URL.Path == "/agent/v1/commands/poll":
			q := f.queue
			f.queue = nil
			json.NewEncoder(w).Encode(map[string]any{"commands": q, "poll": len(f.queue) > 0})
		case strings.HasPrefix(r.URL.Path, "/agent/v1/commands/") && strings.HasSuffix(r.URL.Path, "/result"):
			var res CommandResult
			_ = json.Unmarshal(body, &res)
			f.results[strings.Split(r.URL.Path, "/")[4]] = res
			w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.Close)
	return f
}
func (f *fakeApp) evs() []Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Event(nil), f.events...)
}

func newTestAgent(t *testing.T, app *fakeApp, mut func(*Config), sys *fakeSys, run Runner) *Agent {
	cfg := testCfg(t, app.URL)
	if mut != nil {
		mut(&cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	a := NewAgent(cfg, sys, run, NewClient(cfg, "test"), "test", quiet())
	return a
}

// ---------- kebijakan blokir
func TestBlockedPolicy(t *testing.T) {
	bad := []string{"rm -rf /", "rm -rf /*", "reboot", "sudo shutdown -h now", "mkfs.ext4 /dev/sdb", "dd if=/dev/zero of=/dev/sda", "curl http://x.sh | bash", "zpool destroy tank", "zfs destroy -r a/b", `mysql -e "DROP DATABASE x"`, "passwd root", "iptables -F", "qm destroy 100", "", "systemctl poweroff"}
	for _, c := range bad {
		if _, b := Blocked(c); !b {
			t.Errorf("seharusnya diblokir: %q", c)
		}
	}
	ok := []string{"systemctl restart nginx", "sysctl -w vm.swappiness=10", "journalctl --vacuum-size=200M", "sed -i 's/a/b/' /etc/x.conf", "rm -f /var/log/app/old.log", "cp -a /etc/mysql/my.cnf /etc/mysql/my.cnf.bak"}
	for _, c := range ok {
		if why, b := Blocked(c); b {
			t.Errorf("seharusnya lolos: %q (%s)", c, why)
		}
	}
}

// ---------- mesin status
func TestStateHysteresis(t *testing.T) {
	s := &CheckState{}
	now := time.Unix(1000, 0)
	crit, ok, unk := Result{Crit: true}, Result{}, Result{Unknown: true}
	steps := []struct {
		r    Result
		want string
	}{{crit, ""}, {ok, ""}, {crit, ""}, {crit, TransOpen}, {crit, ""}, {unk, ""}, {ok, ""}, {crit, ""}, {ok, ""}, {ok, TransResolved}, {ok, ""}}
	for i, st := range steps {
		if got := s.Observe(st.r, 2, 2, 0, now); got != st.want {
			t.Fatalf("langkah %d: dapat %q, mau %q", i, got, st.want)
		}
	}
}
func TestStateReannounce(t *testing.T) {
	s := &CheckState{}
	t0 := time.Unix(0, 0)
	s.Observe(Result{Crit: true}, 1, 1, time.Hour, t0)
	if s.Observe(Result{Crit: true}, 1, 1, time.Hour, t0.Add(59*time.Minute)) != "" {
		t.Fatal("belum waktunya kirim ulang")
	}
	if s.Observe(Result{Crit: true}, 1, 1, time.Hour, t0.Add(61*time.Minute)) != TransStillOpen {
		t.Fatal("seharusnya kirim ulang setelah 1 jam")
	}
}

// ---------- pemeriksaan
func TestChecksThresholds(t *testing.T) {
	sys := &fakeSys{cores: 4, load: 13, mem: 3, disk: 97, psi: 60, psiOK: true}
	run := &fakeRun{outs: map[string]string{"is-active 'nginx'": "inactive\n", "is-active 'mysql'": "active\n", "SELECT COUNT": "250\n"}}
	cfg := DefaultConfig()
	cfg.Services = []string{"nginx", "mysql"}
	cfg.Commands = []CmdCheck{{Name: "failed_jobs", Cmd: "SELECT COUNT", Crit: 100}, {Name: "workers", Cmd: "SELECT COUNT", Crit: 300, Dir: "lt"}}
	got := map[string]Result{}
	for _, c := range BuildChecks(cfg, sys, run) {
		got[c.Key] = c.Run(context.Background())
	}
	wantCrit := []string{"load", "mem", "disk:/", "io", "svc:nginx", "cmd:failed_jobs", "cmd:workers"}
	for _, k := range wantCrit {
		if got[k].Lvl() != LevelCritical {
			t.Errorf("%s seharusnya kritis: %+v", k, got[k])
		}
	}
	if got["svc:mysql"].Crit {
		t.Error("mysql aktif tidak boleh kritis")
	}
	sys.load, sys.mem, sys.disk, sys.psi = 1, 50, 40, 1
	for _, c := range BuildChecks(cfg, sys, run) {
		if c.Key == "load" || c.Key == "mem" || c.Key == "disk:/" || c.Key == "io" {
			if r := c.Run(context.Background()); r.Lvl() == LevelCritical || r.Unknown {
				t.Errorf("%s seharusnya normal: %+v", c.Key, r)
			}
		}
	}
}
func TestUnknownIsNotCritical(t *testing.T) {
	sys := &fakeSys{cores: 2, err: errors.New("gagal baca"), psiOK: false}
	for _, c := range BuildChecks(DefaultConfig(), sys, &fakeRun{}) {
		r := c.Run(context.Background())
		if r.Lvl() == LevelCritical || !r.Unknown {
			t.Errorf("%s: gagal ukur harus 'tidak terbaca', bukan kritis: %+v", c.Key, r)
		}
	}
}

func TestLogCheckTailAndRotation(t *testing.T) {
	p := filepath.Join(t.TempDir(), "app.log")
	os.WriteFile(p, []byte("lama max_children\nlama max_children\n"), 0o644)
	c := newLogCheck(LogCheck{Name: "fpm", Path: p, Pattern: "max_children", CritDelta: 3})
	run := func() Result { return c.Run(context.Background()) }
	if r := run(); r.Lvl() == LevelCritical || r.Value != 0 {
		t.Fatalf("pembacaan pertama hanya menandai posisi: %+v", r)
	}
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("x max_children\ny\nz max_children\n")
	if r := run(); r.Value != 2 || r.Lvl() == LevelCritical {
		t.Fatalf("2 baru, di bawah batas: %+v", r)
	}
	f.WriteString("a max_children\nb max_children\nc max_children\n")
	if r := run(); r.Value != 3 || r.Lvl() != LevelCritical {
		t.Fatalf("3 baru = kritis: %+v", r)
	}
	f.Close()
	os.WriteFile(p, []byte("m max_children\n"), 0o644) // rotasi: berkas lebih kecil
	if r := run(); r.Value != 1 {
		t.Fatalf("setelah rotasi mulai dari awal: %+v", r)
	}
	if r := run(); r.Value != 0 {
		t.Fatalf("tanpa baris baru = 0: %+v", r)
	}
}

func TestHTTPCheck(t *testing.T) {
	code := 200
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code) }))
	defer s.Close()
	cfg := DefaultConfig()
	cfg.Thresholds = Thresholds{}
	cfg.HTTP = []HTTPCheck{{Name: "app", URL: s.URL, CritMs: 5000}}
	c := BuildChecks(cfg, &fakeSys{cores: 1}, &fakeRun{})[0]
	if r := c.Run(context.Background()); r.Lvl() == LevelCritical {
		t.Fatalf("200 harus normal: %+v", r)
	}
	code = 502
	if r := c.Run(context.Background()); r.Lvl() != LevelCritical {
		t.Fatalf("502 harus kritis: %+v", r)
	}
	s.Close()
	if r := c.Run(context.Background()); r.Lvl() != LevelCritical {
		t.Fatalf("tanpa jawaban harus kritis: %+v", r)
	}
}

// ---------- diagnostik
func TestRedactAndCaps(t *testing.T) {
	in := "user=a password=hunter2 token: abc123 Authorization: Bearer abcdefghijklmnop DB_API_KEY=xyz"
	out := Redact(in)
	for _, leak := range []string{"hunter2", "abc123", "abcdefghijklmnop", "xyz"} {
		if strings.Contains(out, leak) {
			t.Errorf("rahasia bocor (%s): %s", leak, out)
		}
	}
	big := strings.Repeat("x", 50000)
	run := &fakeRun{outs: map[string]string{"a": big, "b": big, "c": big, "d": big, "e": big}}
	d := CollectDiag(context.Background(), run, []DiagSpec{{"a", "a"}, {"b", "b"}, {"c", "c"}, {"d", "d"}, {"e", "e"}})
	total := 0
	for _, x := range d {
		total += len(x.Out)
		if len(x.Out) > diagPerCmd+20 {
			t.Errorf("keluaran %s melewati batas: %d", x.Name, len(x.Out))
		}
	}
	if total > diagTotal {
		t.Errorf("total diagnostik %d melewati %d", total, diagTotal)
	}
}

// ---------- agen penuh terhadap aplikasi tiruan
func TestAgentOnlySendsCriticalChanges(t *testing.T) {
	app := newFakeApp(t)
	sys := &fakeSys{cores: 4, load: 0.5, mem: 60, disk: 40, psi: 1, psiOK: true}
	a := newTestAgent(t, app, nil, sys, &fakeRun{outs: map[string]string{"free": "total 8000", "ps ": "PID COMM\n1 init"}})
	ctx := context.Background()

	// 24 jam sehat (30 dtk sekali): TIDAK ADA satu pun kejadian yang dikirim
	for i := 0; i < 24*120; i++ {
		a.Tick(ctx)
	}
	a.Flush(ctx)
	if n := len(app.evs()); n != 0 {
		t.Fatalf("kondisi sehat tidak boleh mengirim kejadian, dapat %d", n)
	}

	// memori kritis: baru "open" setelah konfirmasi 2x, dan hanya SATU kejadian walau kritis berlarut-larut
	sys.mem = 2
	for i := 0; i < 50; i++ {
		a.Tick(ctx)
	}
	a.Flush(ctx)
	evs := app.evs()
	if len(evs) != 1 || evs[0].Type != "open" || evs[0].Key != "mem" || evs[0].Severity != "critical" {
		t.Fatalf("seharusnya 1 kejadian open untuk mem: %+v", evs)
	}
	if len(evs[0].Diag) == 0 {
		t.Error("kejadian open membawa diagnostik")
	}
	// pulih
	sys.mem = 60
	for i := 0; i < 3; i++ {
		a.Tick(ctx)
	}
	a.Flush(ctx)
	evs = app.evs()
	if len(evs) != 2 || evs[1].Type != "resolved" || len(evs[1].Diag) != 0 {
		t.Fatalf("seharusnya resolved tanpa diagnostik: %+v", evs)
	}
}

func TestAgentDailyVolumeIsTiny(t *testing.T) {
	app := newFakeApp(t)
	sys := &fakeSys{cores: 4, load: 0.5, mem: 60, disk: 40, psi: 1, psiOK: true}
	a := newTestAgent(t, app, nil, sys, &fakeRun{})
	ctx := context.Background()
	for i := 0; i < 24*60; i++ { // heartbeat tiap 60 dtk selama 24 jam
		if err := a.Heartbeat(ctx); err != nil {
			t.Fatal(err)
		}
	}
	perDay := app.reqBytes
	t.Logf("heartbeat 24 jam: %d byte badan permintaan (%.0f KB)", perDay, float64(perDay)/1024)
	if perDay > 400*1024 {
		t.Fatalf("volume heartbeat sehari terlalu besar: %d byte", perDay)
	}
	if app.beats != 24*60 {
		t.Fatalf("heartbeat tidak lengkap: %d", app.beats)
	}
}

func TestAgentSpoolsWhenAppDownAndDeliversLater(t *testing.T) {
	app := newFakeApp(t)
	app.status = 503
	sys := &fakeSys{cores: 2, load: 0.1, mem: 2, disk: 10, psi: 1, psiOK: true}
	a := newTestAgent(t, app, nil, sys, &fakeRun{})
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		a.Tick(ctx)
	}
	if err := a.Flush(ctx); err == nil {
		t.Fatal("aplikasi 503 seharusnya menghasilkan galat kirim")
	}
	if a.spool.Len() != 1 {
		t.Fatalf("kejadian harus tertahan di spool: %d", a.spool.Len())
	}
	// agen restart: spool dibaca dari disk
	a2 := NewAgent(a.cfg, sys, &fakeRun{}, NewClient(a.cfg, "test"), "test", quiet())
	if a2.spool.Len() != 1 {
		t.Fatalf("spool harus bertahan setelah restart: %d", a2.spool.Len())
	}
	app.status = 0
	if err := a2.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if n := len(app.evs()); n != 1 || a2.spool.Len() != 0 {
		t.Fatalf("terkirim %d, sisa spool %d", n, a2.spool.Len())
	}
}

func TestAgentBackoffAndBadKey(t *testing.T) {
	app := newFakeApp(t)
	sys := &fakeSys{cores: 2, load: 0.1, mem: 2, disk: 10, psi: 1, psiOK: true}
	a := newTestAgent(t, app, func(c *Config) { c.Secret = strings.Repeat("z", 40) }, sys, &fakeRun{})
	ctx := context.Background()
	a.Tick(ctx)
	a.Tick(ctx)
	err := a.Flush(ctx)
	if err == nil || !strings.Contains(err.Error(), "kunci ditolak") {
		t.Fatalf("kunci salah harus dilaporkan jelas: %v", err)
	}
	app.mu.Lock()
	n := app.badSig
	app.mu.Unlock()
	if n != 1 {
		t.Fatalf("satu permintaan ditolak: %d", n)
	}
	if err := a.Flush(ctx); err != nil {
		t.Fatal("selama backoff tidak boleh menembak ulang aplikasi")
	}
	app.mu.Lock()
	n2 := app.badSig
	app.mu.Unlock()
	if n2 != 1 {
		t.Fatalf("backoff harus mencegah permintaan baru: %d", n2)
	}
	if a.spool.Len() != 1 {
		t.Fatal("kejadian tidak boleh hilang saat kunci ditolak")
	}
}

func TestPoisonEventIsDropped(t *testing.T) {
	app := newFakeApp(t)
	app.status = 422
	sys := &fakeSys{cores: 2, load: 0.1, mem: 2, disk: 10, psi: 1, psiOK: true}
	a := newTestAgent(t, app, nil, sys, &fakeRun{})
	a.Tick(context.Background())
	a.Tick(context.Background())
	if err := a.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.spool.Len() != 0 {
		t.Fatal("kejadian yang ditolak permanen harus dibuang agar spool tidak macet")
	}
}

func TestSpoolCap(t *testing.T) {
	s := LoadSpool(filepath.Join(t.TempDir(), "s.json"), 5)
	for i := 0; i < 20; i++ {
		s.Add(Event{ID: string(rune('a' + i))})
	}
	if s.Len() != 5 || s.Peek(1)[0].ID != string(rune('a'+15)) {
		t.Fatalf("spool harus menyimpan 5 terbaru: %d %v", s.Len(), s.Peek(1))
	}
}

// ---------- tanda tangan
func TestSignatures(t *testing.T) {
	a := Sign(secret, "1", "POST", "/x", []byte("{}"))
	if a != Sign(secret, "1", "POST", "/x", []byte("{}")) || a == Sign(secret, "2", "POST", "/x", []byte("{}")) || a == Sign(secret, "1", "POST", "/y", []byte("{}")) || a == Sign(secret, "1", "POST", "/x", []byte("{ }")) || a == Sign("lain"+secret, "1", "POST", "/x", []byte("{}")) {
		t.Fatal("tanda tangan harus deterministik dan terikat pada ts, path, badan, dan secret")
	}
	c := Command{ID: "c1", Command: "uptime", TimeoutS: 30, Expires: 99}
	c.Sig = CommandSig(secret, c.ID, c.Expires, c.TimeoutS, c.Command)
	if !VerifyCommandSig(secret, c) {
		t.Fatal("tanda tangan perintah valid harus lolos")
	}
	c.Command = "reboot"
	if VerifyCommandSig(secret, c) {
		t.Fatal("perintah yang diubah harus gagal verifikasi")
	}
}

// ---------- eksekusi perintah yang disetujui (butuh sh)
func signed(id, cmd string, ttl time.Duration) Command {
	c := Command{ID: id, Command: cmd, TimeoutS: 5, Expires: time.Now().Add(ttl).Unix()}
	c.Sig = CommandSig(secret, c.ID, c.Expires, c.TimeoutS, c.Command)
	return c
}
func TestExecutorPolicy(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("butuh sh Linux")
	}
	cfg := testCfg(t, "https://x.example")
	cfg.AllowExec = true
	x := NewExecutor(cfg, time.Now)
	ctx := context.Background()
	if r := x.Handle(ctx, signed("a1", "echo halo && exit 3", time.Minute)); r.Rejected != "" || r.Exit != 3 || !strings.Contains(r.Stdout, "halo") {
		t.Fatalf("perintah sah harus jalan: %+v", r)
	}
	if r := x.Handle(ctx, signed("a1", "echo lagi", time.Minute)); r.Rejected == "" {
		t.Fatalf("replay harus ditolak: %+v", r)
	}
	bad := signed("a2", "echo x", time.Minute)
	bad.Command = "echo diubah"
	if r := x.Handle(ctx, bad); !strings.Contains(r.Rejected, "tanda tangan") {
		t.Fatalf("tanda tangan salah harus ditolak: %+v", r)
	}
	if r := x.Handle(ctx, signed("a3", "echo x", -time.Minute)); !strings.Contains(r.Rejected, "kedaluwarsa") {
		t.Fatalf("kedaluwarsa harus ditolak: %+v", r)
	}
	if r := x.Handle(ctx, signed("a4", "rm -rf /", time.Minute)); !strings.Contains(r.Rejected, "diblokir") {
		t.Fatalf("perintah merusak harus ditolak agen walau bertanda tangan: %+v", r)
	}
	if r := x.Handle(ctx, signed("a5", "echo $(printf 'password=rahasia123')", time.Minute)); strings.Contains(r.Stdout, "rahasia123") {
		t.Fatalf("keluaran harus disamarkan: %+v", r)
	}
	t0 := time.Now()
	slow := signed("a6", "sleep 30", time.Minute)
	slow.TimeoutS = 1
	slow.Sig = CommandSig(secret, slow.ID, slow.Expires, slow.TimeoutS, slow.Command)
	if r := x.Handle(ctx, slow); !r.TimedOut || time.Since(t0) > 5*time.Second {
		t.Fatalf("waktu habis harus mematikan perintah: %+v (%v)", r, time.Since(t0))
	}
	if r := x.Handle(ctx, signed("a7", "yes | head -c 200000", time.Minute)); len(r.Stdout) > 13000 {
		t.Fatalf("keluaran harus dibatasi: %d", len(r.Stdout))
	}
	// replay tetap ditolak setelah agen restart
	x2 := NewExecutor(cfg, time.Now)
	if r := x2.Handle(ctx, signed("a1", "echo lagi", time.Minute)); r.Rejected == "" {
		t.Fatal("riwayat perintah harus bertahan setelah restart")
	}
}

func TestExecutorDisabledByDefault(t *testing.T) {
	cfg := testCfg(t, "https://x.example")
	x := NewExecutor(cfg, time.Now)
	if r := x.Handle(context.Background(), signed("b1", "echo x", time.Minute)); !strings.Contains(r.Rejected, "allow_exec") {
		t.Fatalf("eksekusi mati secara bawaan: %+v", r)
	}
}

func TestPollRunsApprovedCommandAndReports(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("butuh sh Linux")
	}
	app := newFakeApp(t)
	app.queue = []Command{signed("p1", "echo selesai", time.Minute)}
	a := newTestAgent(t, app, func(c *Config) { c.AllowExec = true }, &fakeSys{cores: 2, load: 0.1, mem: 50, disk: 10, psiOK: false}, &fakeRun{})
	n, err := a.PollOnce(context.Background(), 1)
	if err != nil || n != 1 {
		t.Fatalf("poll: %d %v", n, err)
	}
	app.mu.Lock()
	r := app.results["p1"]
	app.mu.Unlock()
	if r.Exit != 0 || !strings.Contains(r.Stdout, "selesai") {
		t.Fatalf("hasil harus dilaporkan: %+v", r)
	}
}

// ---------- konfigurasi
func TestConfigValidation(t *testing.T) {
	good := testCfg(t, "https://aiops.example")
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mut := range map[string]func(*Config){
		"http tanpa insecure": func(c *Config) { c.ServerURL, c.InsecureHTTP = "http://x", false },
		"secret pendek":       func(c *Config) { c.Secret = "pendek" },
		"tanpa key":           func(c *Config) { c.KeyID = "" },
		"interval kecil":      func(c *Config) { c.IntervalSeconds = 1 },
		"port salah":          func(c *Config) { c.Ports = []PortCheck{{Name: "x", Port: 99999}} },
	} {
		c := good
		mut(&c)
		if c.Validate() == nil {
			t.Errorf("%s seharusnya ditolak", name)
		}
	}
}

func TestHeartbeatBodyHasEmptyArrayNotNull(t *testing.T) {
	app := newFakeApp(t)
	a := newTestAgent(t, app, nil, &fakeSys{cores: 1}, &fakeRun{})
	if b, _ := json.Marshal(a.openKeys()); string(b) != "[]" {
		t.Fatalf("openKeys harus [] bukan %s", b)
	}
}

// ---------- HTTPS dengan CA internal
func TestCAFileTrustsInternalCA(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"ok":true,"poll":false}`)) }))
	defer srv.Close()
	caPath := filepath.Join(t.TempDir(), "ca.pem")
	os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600)

	cfg := testCfg(t, srv.URL)
	cfg.InsecureHTTP = false
	// tanpa ca_file: sertifikat tidak dikenal sistem -> koneksi harus GAGAL (agen tidak boleh diam-diam menerima sertifikat asing)
	c1 := NewClient(cfg, "t")
	if _, _, err := c1.Do(context.Background(), "POST", "/agent/v1/heartbeat", []byte("{}")); err == nil {
		t.Fatal("tanpa ca_file sertifikat self-signed harus ditolak")
	}
	cfg.CAFile = caPath
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	c2 := NewClient(cfg, "t")
	code, _, err := c2.Do(context.Background(), "POST", "/agent/v1/heartbeat", []byte("{}"))
	if err != nil || code != 200 {
		t.Fatalf("dengan ca_file harus berhasil: %d %v", code, err)
	}
	_ = tls.VersionTLS12
}

func TestCAFileValidation(t *testing.T) {
	cfg := testCfg(t, "https://x.example")
	cfg.InsecureHTTP = false
	cfg.CAFile = filepath.Join(t.TempDir(), "tidak-ada.pem")
	if cfg.Validate() == nil {
		t.Fatal("ca_file yang tidak ada harus ditolak")
	}
	bad := filepath.Join(t.TempDir(), "bad.pem")
	os.WriteFile(bad, []byte("bukan pem"), 0o600)
	cfg.CAFile = bad
	if cfg.Validate() == nil {
		t.Fatal("ca_file tanpa sertifikat valid harus ditolak")
	}
}

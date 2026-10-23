package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLimitEvalBothDirectionsAndMissingBounds(t *testing.T) {
	up := Limit{Minor: ptr(5), Major: ptr(10), Critical: ptr(20)}
	for v, want := range map[float64]Level{4.9: LevelOK, 5: LevelMinor, 9.9: LevelMinor, 10: LevelMajor, 19: LevelMajor, 20: LevelCritical, 99: LevelCritical} {
		if lv, _ := up.Eval(v, "gt"); lv != want {
			t.Errorf("gt %v: dapat %v, harapan %v", v, lv, want)
		}
	}
	down := Limit{Minor: ptr(20), Major: ptr(10), Critical: ptr(5)}
	for v, want := range map[float64]Level{25: LevelOK, 20: LevelMinor, 11: LevelMinor, 10: LevelMajor, 6: LevelMajor, 5: LevelCritical, 0: LevelCritical} {
		if lv, _ := down.Eval(v, "lt"); lv != want {
			t.Errorf("lt %v: dapat %v, harapan %v", v, lv, want)
		}
	}
	if lv, _ := (Limit{}).Eval(1e9, "gt"); lv != LevelOK {
		t.Error("tanpa batas apa pun tidak pernah memicu")
	}
	if lv, th := (Limit{Critical: ptr(3)}).Eval(4, "gt"); lv != LevelCritical || th != 3 {
		t.Errorf("hanya Critical: %v %v", lv, th)
	}
	if ParseLevel("Major", LevelCritical) != LevelMajor || ParseLevel("kritis", LevelOK) != LevelCritical || ParseLevel("entah", LevelMinor) != LevelMinor || ParseLevel("", LevelInfo) != LevelInfo {
		t.Error("ParseLevel")
	}
}

func TestStateReportsLevelChangesAndResolvesWithLastLevel(t *testing.T) {
	var s CheckState
	now := time.Unix(1000, 0)
	obs := func(lv Level) string { return s.Observe(Result{Level: lv}, 2, 2, 0, now) }
	if obs(LevelMajor) != TransNone || obs(LevelMajor) != TransOpen || s.Cur != LevelMajor {
		t.Fatal("Major dibuka setelah dua kali berturut-turut")
	}
	if obs(LevelMajor) != TransNone {
		t.Fatal("level sama tidak mengulang")
	}
	if obs(LevelCritical) != TransNone || obs(LevelCritical) != TransOpen || s.Cur != LevelCritical {
		t.Fatal("naik ke Critical dilaporkan lagi (open dengan tingkat baru) setelah dikonfirmasi")
	}
	if obs(LevelMinor) != TransNone || obs(LevelMinor) != TransOpen || s.Cur != LevelMinor {
		t.Fatal("turun ke Minor juga dilaporkan, supaya aplikasi memperbarui tingkat")
	}
	if obs(LevelOK) != TransNone || obs(LevelOK) != TransResolved || s.Open {
		t.Fatal("pulih setelah dua kali normal")
	}
	if s.Last != LevelMinor {
		t.Fatalf("kejadian resolved membawa tingkat terakhir yang dilaporkan: %v", s.Last)
	}
	// naik-turun cepat (tidak stabil dua kali berturut-turut) tidak menghasilkan kejadian
	var f CheckState
	for i, lv := range []Level{LevelMajor, LevelCritical, LevelMajor, LevelCritical} {
		if f.Observe(Result{Level: lv}, 2, 2, 0, now) != TransNone {
			t.Fatalf("goyang antar tingkat (langkah %d) tidak boleh membuka", i)
		}
	}
}

func TestTuningRemoteOverridesLocalAndFallsBack(t *testing.T) {
	dir := t.TempDir()
	tn := NewTuning(dir)
	local := Limit{Critical: ptr(3)}
	if got := tn.Limit("load", local); got.Critical == nil || *got.Critical != 3 || got.Major != nil {
		t.Fatalf("tanpa konfigurasi dari aplikasi: pakai lokal: %+v", got)
	}
	if tn.Event("sec:users", LevelCritical) != LevelCritical {
		t.Fatal("tingkat kejadian bawaan")
	}
	tn.Set(RemoteConfig{Version: "v1", Limits: map[string]Limit{"load": {Minor: ptr(1), Major: ptr(1.5), Critical: ptr(3)}}, Events: map[string]string{"sec:users": "major"}})
	if got := tn.Limit("load", local); got.Minor == nil || *got.Minor != 1 || *got.Major != 1.5 {
		t.Fatalf("konfigurasi aplikasi menggantikan lokal: %+v", got)
	}
	if got := tn.Limit("mem", Limit{Critical: ptr(5)}); *got.Critical != 5 {
		t.Fatal("kunci yang tidak ada di aplikasi tetap lokal")
	}
	if tn.Event("sec:users", LevelCritical) != LevelMajor || tn.Event("sec:ports", LevelMajor) != LevelMajor {
		t.Fatal("tingkat kejadian dari aplikasi")
	}
	// salinan terakhir dipakai setelah agen dimulai ulang, walau aplikasi belum terjangkau
	again := NewTuning(dir)
	if again.Version() != "v1" || again.Event("sec:users", LevelCritical) != LevelMajor {
		t.Fatalf("konfigurasi harus bertahan setelah restart: %q", again.Version())
	}
	if st, err := os.Stat(filepath.Join(dir, "remote-config.json")); err != nil || st.Mode().Perm()&0o077 != 0 && !strings.Contains(strings.ToLower(os.Getenv("OS")), "windows") {
		t.Fatalf("berkas konfigurasi mode 0600: %v %v", err, st)
	}
	var nilT *Tuning
	if nilT.Limit("x", local).Critical == nil || nilT.Event("x", LevelMinor) != LevelMinor || nilT.Version() != "" {
		t.Fatal("Tuning nil aman dipakai")
	}
}

func TestBaseChecksUseRemoteLimitsAndReportTheirLevel(t *testing.T) {
	cfg := DefaultConfig()
	cfg.tune = &Tuning{}
	sys := &fakeSys{cores: 4, load: 0.5, mem: 60, disk: 40, psi: 1, psiOK: true}
	run := func(key string) Result {
		for _, c := range BuildChecks(cfg, sys, &fakeRun{}) {
			if c.Key == key {
				return c.Run(context.Background())
			}
		}
		t.Fatalf("pemeriksaan %s tidak ada", key)
		return Result{}
	}
	sys.disk = 80
	if r := run("disk:/"); r.Lvl() != LevelOK {
		t.Fatalf("tanpa konfigurasi aplikasi hanya critical (95): %+v", r)
	}
	cfg.tune.Set(RemoteConfig{Version: "v1", Limits: map[string]Limit{"disk": {Minor: ptr(75), Major: ptr(85), Critical: ptr(95)}, "mem": {Minor: ptr(20), Major: ptr(10), Critical: ptr(5)}, "load": {Minor: ptr(1), Major: ptr(1.5), Critical: ptr(3)}}})
	if r := run("disk:/"); r.Lvl() != LevelMinor || !strings.Contains(r.Detail, "MINOR di atas 75%") {
		t.Fatalf("80%% = Minor dan keterangan menyebut batasnya: %+v", r)
	}
	sys.disk = 90
	if r := run("disk:/"); r.Lvl() != LevelMajor {
		t.Fatalf("90%% = Major: %+v", r)
	}
	sys.disk = 97
	if r := run("disk:/"); r.Lvl() != LevelCritical {
		t.Fatalf("97%% = Critical: %+v", r)
	}
	sys.mem = 15
	if r := run("mem"); r.Lvl() != LevelMinor {
		t.Fatalf("memori 15%% (arah turun) = Minor: %+v", r)
	}
	sys.mem = 8
	if r := run("mem"); r.Lvl() != LevelMajor {
		t.Fatalf("memori 8%% = Major: %+v", r)
	}
	sys.load = 7 // 7 / 4 core = 1,75 x core
	if r := run("load"); r.Lvl() != LevelMajor {
		t.Fatalf("beban 1,75x core = Major: %+v", r)
	}
	cfg.Thresholds.DiskPctCrit = 0 // dimatikan secara lokal: tetap mati walau aplikasi punya batas
	for _, c := range BuildChecks(cfg, sys, &fakeRun{}) {
		if c.Key == "disk:/" {
			t.Fatal("pemeriksaan yang dimatikan secara lokal tidak boleh hidup lagi")
		}
	}
}

func TestOptionalLevelsOnServicesPortsHTTPLogsAndCommands(t *testing.T) {
	cfg := DefaultConfig()
	cfg.tune = &Tuning{}
	cfg.Services = []string{"redis", "nginx"}
	cfg.ServiceLevels = map[string]string{"redis": "major"}
	cfg.Ports = []PortCheck{{Name: "kecil", Port: 1, Level: "minor"}}
	f := 5.0
	cfg.Commands = []CmdCheck{{Name: "antre", Cmd: "SELECT COUNT", Crit: 100, Major: &f}}
	run := &fakeRun{outs: map[string]string{"is-active": "inactive\n", "SELECT COUNT": "7\n"}}
	got := map[string]Result{}
	for _, c := range BuildChecks(cfg, &fakeSys{cores: 1, load: 0, mem: 99, disk: 1, psi: 0, psiOK: true}, run) {
		got[c.Key] = c.Run(context.Background())
	}
	if got["svc:redis"].Lvl() != LevelMajor || got["svc:nginx"].Lvl() != LevelCritical {
		t.Fatalf("tingkat layanan: redis major, nginx bawaan critical: %+v %+v", got["svc:redis"], got["svc:nginx"])
	}
	if got["port:1"].Lvl() != LevelMinor {
		t.Fatalf("tingkat port: %+v", got["port:1"])
	}
	if got["cmd:antre"].Lvl() != LevelMajor {
		t.Fatalf("perintah dengan batas Major: nilai 7 >= 5 tetapi < 100: %+v", got["cmd:antre"])
	}
}

// Agen mengambil konfigurasi dari aplikasi saat detak jantung memberi versi baru, lalu melaporkan tingkat yang benar.
func TestAgentSyncsConfigFromAppAndReportsLevels(t *testing.T) {
	app := newFakeApp(t)
	app.configJSON = `{"version":"v7","limits":{"mem":{"minor":20,"major":10,"critical":5}},"events":{}}`
	sys := &fakeSys{cores: 4, load: 0.5, mem: 60, disk: 40, psi: 1, psiOK: true}
	a := newTestAgent(t, app, nil, sys, &fakeRun{outs: map[string]string{"free": "total", "ps ": "PID"}})
	ctx := context.Background()
	if err := a.Heartbeat(ctx); err != nil {
		t.Fatal(err)
	}
	if a.tune.Version() != "v7" || app.configFetches != 1 {
		t.Fatalf("agen harus mengambil konfigurasi saat versi berbeda: %q, diambil %d kali", a.tune.Version(), app.configFetches)
	}
	if err := a.Heartbeat(ctx); err != nil || app.configFetches != 1 {
		t.Fatalf("versi sama tidak mengambil lagi: %v, %d", err, app.configFetches)
	}
	sys.mem = 8 // Major menurut batas dari aplikasi (lokal hanya critical di 5)
	for i := 0; i < 3; i++ {
		a.Tick(ctx)
	}
	a.Flush(ctx)
	evs := app.evs()
	if len(evs) != 1 || evs[0].Type != "open" || evs[0].Key != "mem" || evs[0].Severity != "major" {
		t.Fatalf("seharusnya satu kejadian open bertingkat major: %+v", evs)
	}
	sys.mem = 3 // naik ke Critical
	for i := 0; i < 3; i++ {
		a.Tick(ctx)
	}
	a.Flush(ctx)
	evs = app.evs()
	if len(evs) != 2 || evs[1].Type != "open" || evs[1].Severity != "critical" {
		t.Fatalf("kenaikan tingkat dilaporkan sebagai open baru: %+v", evs)
	}
	sys.mem = 60
	for i := 0; i < 3; i++ {
		a.Tick(ctx)
	}
	a.Flush(ctx)
	evs = app.evs()
	if len(evs) != 3 || evs[2].Type != "resolved" || evs[2].Severity != "critical" {
		t.Fatalf("resolved membawa tingkat terakhir: %+v", evs)
	}
}

func TestSyncConfigFailureKeepsWhatWeHave(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer srv.Close()
	cfg := testCfg(t, srv.URL)
	a := NewAgent(cfg, &fakeSys{cores: 1}, &fakeRun{}, NewClient(cfg, "test"), "test", quiet())
	a.tune.Set(RemoteConfig{Version: "lama", Limits: map[string]Limit{"mem": {Critical: ptr(5)}}})
	if err := a.SyncConfig(context.Background()); err == nil {
		t.Fatal("jawaban 500 harus dilaporkan sebagai galat")
	}
	if a.tune.Version() != "lama" {
		t.Fatal("gagal mengambil tidak boleh menghapus konfigurasi yang ada")
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(map[string]string{"x": "y"}) }))
	defer bad.Close()
	cfg2 := testCfg(t, bad.URL)
	b := NewAgent(cfg2, &fakeSys{cores: 1}, &fakeRun{}, NewClient(cfg2, "test"), "test", quiet())
	if err := b.SyncConfig(context.Background()); err == nil || b.tune.Version() != "" {
		t.Fatal("jawaban tanpa versi ditolak")
	}
}

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// secEnv membuat pohon berkas palsu (passwd, sudoers, sshd_config, /proc/net/tcp, auth.log) di folder sementara
// dan mengarahkan secPaths ke sana selama tes.
type secEnv struct {
	t    *testing.T
	dir  string
	now  time.Time
	auth string
}

const procHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

func newSecEnv(t *testing.T) *secEnv {
	d := t.TempDir()
	e := &secEnv{t: t, dir: d, now: time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC), auth: filepath.Join(d, "auth.log")}
	oldPaths, oldClock := secPaths, securityClock
	secPaths = secFiles{Passwd: filepath.Join(d, "passwd"), Sudoers: filepath.Join(d, "sudoers"), SudoersD: filepath.Join(d, "sudoers.d"),
		SSHDConfig: filepath.Join(d, "sshd_config"), SSHDConfigD: filepath.Join(d, "sshd_config.d"), ProcTCP: filepath.Join(d, "tcp"), ProcTCP6: filepath.Join(d, "tcp6"), AuthLog1: e.auth, AuthLog2: filepath.Join(d, "secure"), HomePrefix: d}
	securityClock = func() time.Time { return e.now }
	t.Cleanup(func() { secPaths, securityClock = oldPaths, oldClock })
	os.MkdirAll(secPaths.SudoersD, 0o755)
	os.MkdirAll(secPaths.SSHDConfigD, 0o755)
	e.write(e.auth, "")
	e.passwd("root:x:0:0:root:/root:/bin/bash", "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin", "ubuntu:x:1000:1000::/home/ubuntu:/bin/bash")
	e.write(secPaths.Sudoers, "root ALL=(ALL:ALL) ALL\n")
	e.write(secPaths.SSHDConfig, "PasswordAuthentication no\n")
	e.write(filepath.Join(d, "home", "ubuntu", ".ssh", "authorized_keys"), "ssh-ed25519 AAAAC3RAHASIA-KUNCI ubuntu@laptop\n")
	e.tcp("0100007F:0CEA", "00000000:0016") // 127.0.0.1:3306 (loopback, diabaikan) dan 0.0.0.0:22
	return e
}
func (e *secEnv) write(p, s string) {
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		e.t.Fatal(err)
	}
}
func (e *secEnv) passwd(lines ...string) { e.write(secPaths.Passwd, strings.Join(lines, "\n")+"\n") }
func (e *secEnv) tcp(addrs ...string) {
	var b strings.Builder
	b.WriteString(procHeader)
	for i, a := range addrs {
		fmt.Fprintf(&b, "   %d: %s 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 %d 1 0000000000000000 100 0 0 10 0\n", i, a, 1000+i)
	}
	e.write(secPaths.ProcTCP, b.String())
}
func (e *secEnv) logLine(s string) {
	f, err := os.OpenFile(e.auth, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		e.t.Fatal(err)
	}
	defer f.Close()
	f.WriteString(s + "\n")
}

func secCfg(t *testing.T, mut func(*Security)) Config {
	c := DefaultConfig()
	c.StateDir = t.TempDir()
	c.IntervalSeconds = 30
	c.Security.Enabled = true
	if mut != nil {
		mut(&c.Security)
	}
	return c
}

func checkByKey(cs []*Check, key string) *Check {
	for _, c := range cs {
		if c.Key == key {
			return c
		}
	}
	return nil
}

func TestSecurityConfigValidation(t *testing.T) {
	ok := DefaultConfig()
	ok.ServerURL, ok.KeyID, ok.Secret, ok.InsecureHTTP = "http://x", "k", secret, true
	if err := ok.Validate(); err != nil {
		t.Fatalf("bawaan (mati) harus valid: %v", err)
	}
	if ok.Security.Enabled {
		t.Fatal("pemeriksaan keamanan harus mati secara bawaan supaya agen lama tidak berubah perilakunya")
	}
	bad := map[string]func(*Security){
		"watch asing":               func(s *Security) { s.Watch = []string{"users", "kernel"} },
		"jendela terlalu pendek":    func(s *Security) { s.SSHFailWindowS = 10 },
		"masa lapor terlalu pendek": func(s *Security) { s.HoldMinutes = 1 },
		"batas negatif":             func(s *Security) { s.SSHFailCrit = -1 },
	}
	for name, mut := range bad {
		c := ok
		c.Security.Enabled = true
		mut(&c.Security)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: seharusnya ditolak", name)
		}
	}
	c := ok
	c.Security.Enabled = true
	if err := c.Validate(); err != nil {
		t.Fatalf("diaktifkan dengan bawaan harus valid: %v", err)
	}
}

func TestSecurityDisabledAddsNothing(t *testing.T) {
	cfg := DefaultConfig()
	if n := len(buildSecurityChecks(cfg, &fakeRun{})); n != 0 {
		t.Fatalf("mati = tidak ada pemeriksaan, dapat %d", n)
	}
}

func TestSSHBruteForceWindowAndTopSource(t *testing.T) {
	e := newSecEnv(t)
	cs := buildSecurityChecks(secCfg(t, func(s *Security) { s.SSHFailCrit = 5; s.SSHFailWindowS = 120; s.Watch = []string{"users"} }), &fakeRun{})
	c := checkByKey(cs, "sec:ssh_fail")
	if c == nil {
		t.Fatal("pemeriksaan sec:ssh_fail tidak ada")
	}
	ctx := context.Background()
	if r := c.Run(ctx); r.Lvl() == LevelCritical || r.Unknown { // putaran pertama hanya menandai posisi log
		t.Fatalf("putaran pertama tidak boleh kritis: %+v", r)
	}
	for i := 0; i < 4; i++ {
		e.logLine(fmt.Sprintf("Oct 23 12:00:0%d host sshd[1]: Failed password for root from 203.0.113.9 port 4000%d ssh2", i, i))
	}
	if r := c.Run(ctx); r.Lvl() == LevelCritical || r.Value != 4 {
		t.Fatalf("4 gagal, di bawah batas 5: %+v", r)
	}
	e.logLine("Oct 23 12:00:09 host sshd[1]: Invalid user admin from 198.51.100.7 port 5555")
	e.logLine("Oct 23 12:00:10 host sshd[1]: Accepted publickey for ubuntu from 192.0.2.10 port 1 ssh2") // berhasil: tidak dihitung dan IP-nya tidak dilaporkan
	r := c.Run(ctx)
	if r.Lvl() != LevelCritical || r.Value != 5 {
		t.Fatalf("5 gagal dalam jendela = kritis: %+v", r)
	}
	if !strings.Contains(r.Detail, "203.0.113.9 (4x)") || strings.Contains(r.Detail, "192.0.2.10") {
		t.Fatalf("sumber teratas harus IP penyerang, bukan IP login yang berhasil: %s", r.Detail)
	}
	// jendela 120 dtk = 4 putaran 30 dtk: setelah bergeser, hitungan turun lagi dan status pulih
	for i := 0; i < 4; i++ {
		r = c.Run(ctx)
	}
	if r.Lvl() == LevelCritical || r.Value != 0 {
		t.Fatalf("setelah jendela lewat harus pulih: %+v", r)
	}
}

func TestRootLoginSharesLogWithoutDoubleReading(t *testing.T) {
	e := newSecEnv(t)
	cs := buildSecurityChecks(secCfg(t, func(s *Security) { s.SSHFailCrit = 3; s.RootLogin = true; s.Watch = []string{"users"} }), &fakeRun{})
	fail, root := checkByKey(cs, "sec:ssh_fail"), checkByKey(cs, "sec:root_login")
	if fail == nil || root == nil || cs[0] != fail {
		t.Fatal("kedua pemeriksaan login harus ada, dengan sec:ssh_fail yang pertama (pemilik pembacaan log)")
	}
	ctx := context.Background()
	fail.Run(ctx)
	root.Run(ctx)
	e.logLine("host sshd[1]: Accepted password for root from 203.0.113.50 port 22 ssh2")
	e.logLine("host sshd[1]: Failed password for ubuntu from 203.0.113.51 port 22 ssh2")
	rf := fail.Run(ctx)
	rr := root.Run(ctx)
	if rf.Value != 1 || rr.Value != 1 || rr.Lvl() != LevelMajor {
		t.Fatalf("satu baris log harus dihitung sekali untuk tiap pemeriksaan: gagal=%+v root=%+v", rf, rr)
	}
	// login root saja (tanpa pemeriksaan gagal): pemeriksaan root yang membaca log
	e2 := buildSecurityChecks(secCfg(t, func(s *Security) { s.SSHFailCrit = 0; s.RootLogin = true; s.Watch = []string{"users"} }), &fakeRun{})
	only := checkByKey(e2, "sec:root_login")
	only.Run(ctx)
	e.logLine("host sshd[1]: Accepted publickey for root from 203.0.113.60 port 22 ssh2")
	if r := only.Run(ctx); r.Lvl() != LevelMajor {
		t.Fatalf("login root harus terbaca walau pemeriksaan gagal-login mati: %+v", r)
	}
}

func TestRootLoginOffByDefault(t *testing.T) {
	newSecEnv(t)
	cs := buildSecurityChecks(secCfg(t, nil), &fakeRun{})
	if checkByKey(cs, "sec:root_login") != nil {
		t.Fatal("login root sah di banyak server: pemeriksaannya harus opt-in")
	}
}

func TestAuthFromJournalWhenNoLogFile(t *testing.T) {
	e := newSecEnv(t)
	os.Remove(e.auth)
	run := &fakeRun{outs: map[string]string{"journalctl -u ssh": "Failed password for root from 203.0.113.1 port 1 ssh2\nFailed password for root from 203.0.113.1 port 2 ssh2\n"}}
	cs := buildSecurityChecks(secCfg(t, func(s *Security) { s.SSHFailCrit = 2; s.Watch = []string{"users"} }), run)
	c := checkByKey(cs, "sec:ssh_fail")
	ctx := context.Background()
	if r := c.Run(ctx); r.Lvl() == LevelCritical || r.Unknown {
		t.Fatalf("putaran pertama hanya menandai waktu: %+v", r)
	}
	e.now = e.now.Add(30 * time.Second)
	if r := c.Run(ctx); r.Lvl() != LevelCritical || r.Value != 2 {
		t.Fatalf("journalctl dipakai bila berkas log tidak ada: %+v", r)
	}
	if !strings.Contains(strings.Join(run.cmds, "\n"), "--since @") {
		t.Fatalf("journalctl harus meminta hanya sejak pemeriksaan lalu: %v", run.cmds)
	}
	// journalctl gagal dan tanpa keluaran: tidak diketahui, bukan kritis palsu
	bad := buildSecurityChecks(secCfg(t, func(s *Security) { s.SSHFailCrit = 1; s.Watch = []string{"users"} }), &fakeRun{})
	cb := checkByKey(bad, "sec:ssh_fail")
	cb.Run(ctx)
	e.now = e.now.Add(30 * time.Second)
	if r := cb.Run(ctx); !r.Unknown || r.Lvl() == LevelCritical {
		t.Fatalf("gagal membaca log harus Unknown: %+v", r)
	}
}

func TestWatchersBaselineChangeHoldAndRemoval(t *testing.T) {
	e := newSecEnv(t)
	cfg := secCfg(t, func(s *Security) { s.SSHFailCrit = 0; s.HoldMinutes = 10 })
	cs := buildSecurityChecks(cfg, &fakeRun{})
	ctx := context.Background()
	run := func(key string) Result { return checkByKey(cs, key).Run(ctx) }
	for _, k := range []string{"sec:users", "sec:keys", "sec:sudoers", "sec:sshd", "sec:ports"} {
		if r := run(k); r.Lvl() == LevelCritical || r.Unknown {
			t.Fatalf("%s: keadaan pertama = baseline, bukan kritis: %+v", k, r)
		}
	}
	// akun baru
	e.passwd("root:x:0:0:root:/root:/bin/bash", "ubuntu:x:1000:1000::/home/ubuntu:/bin/bash", "backdoor:x:1001:1001::/home/backdoor:/bin/bash", "svc:x:999:999::/var/svc:/usr/sbin/nologin")
	r := run("sec:users")
	if r.Lvl() != LevelCritical || !strings.Contains(r.Detail, "akun baru: backdoor") || strings.Contains(r.Detail, "svc") {
		t.Fatalf("akun yang bisa login baru harus kritis, akun nologin diabaikan: %+v", r)
	}
	// masih kritis selama masa lapor, lalu diterima sebagai baseline dan menutup sendiri
	e.now = e.now.Add(9 * time.Minute)
	if r := run("sec:users"); r.Lvl() != LevelCritical {
		t.Fatalf("masih dalam masa lapor: %+v", r)
	}
	e.now = e.now.Add(2 * time.Minute)
	if r := run("sec:users"); r.Lvl() == LevelCritical {
		t.Fatalf("setelah masa lapor, keadaan diterima sebagai baseline: %+v", r)
	}
	if r := run("sec:users"); r.Lvl() == LevelCritical {
		t.Fatal("tidak boleh kritis lagi")
	}
	// akun dihapus: diterima diam-diam
	e.passwd("root:x:0:0:root:/root:/bin/bash", "ubuntu:x:1000:1000::/home/ubuntu:/bin/bash")
	if r := run("sec:users"); r.Lvl() == LevelCritical {
		t.Fatalf("penghapusan bukan kejadian genting: %+v", r)
	}
	// authorized_keys berubah: nama akun dilaporkan, isi kunci tidak pernah
	e.write(filepath.Join(e.dir, "home", "ubuntu", ".ssh", "authorized_keys"), "ssh-ed25519 AAAAC3KUNCI-BARU penyerang@host\n")
	r = run("sec:keys")
	if r.Lvl() != LevelCritical || !strings.Contains(r.Detail, "ubuntu") || strings.Contains(r.Detail, "AAAAC3") || strings.Contains(r.Detail, "penyerang") {
		t.Fatalf("laporkan akun, bukan isi kunci: %+v", r)
	}
	// sudoers.d baru, sshd_config berubah
	e.write(filepath.Join(secPaths.SudoersD, "evil"), "ubuntu ALL=(ALL) NOPASSWD:ALL\n")
	if r := run("sec:sudoers"); r.Lvl() != LevelCritical || !strings.Contains(r.Detail, "evil") {
		t.Fatalf("sudoers.d baru harus terlihat: %+v", r)
	}
	e.write(secPaths.SSHDConfig, "PasswordAuthentication yes\nPermitRootLogin yes\n")
	if r := run("sec:sshd"); r.Lvl() != LevelMajor || !strings.Contains(r.Detail, "berubah") || strings.Contains(r.Detail, "PermitRootLogin") {
		t.Fatalf("sshd_config berubah (tanpa isinya): %+v", r)
	}
	// port baru: loopback diabaikan, IPv4 dan IPv6 pada port sama dihitung sekali
	e.tcp("0100007F:0CEA", "00000000:0016", "00000000:1F91", "0100007F:2328")
	r = run("sec:ports")
	if r.Lvl() != LevelMajor || !strings.Contains(r.Detail, "port baru mendengarkan: 8081") || strings.Contains(r.Detail, "9000") {
		t.Fatalf("port 8081 baru, port 9000 hanya loopback: %+v", r)
	}
}

func TestBaselinePersistsAcrossRestartAndIsPrivate(t *testing.T) {
	e := newSecEnv(t)
	cfg := secCfg(t, func(s *Security) { s.SSHFailCrit = 0; s.Watch = []string{"users"} })
	ctx := context.Background()
	buildSecurityChecks(cfg, &fakeRun{})
	first := checkByKey(buildSecurityChecks(cfg, &fakeRun{}), "sec:users")
	first.Run(ctx) // menulis baseline
	info, err := os.Stat(filepath.Join(cfg.StateDir, "security-baseline.json"))
	if err != nil {
		t.Fatalf("baseline harus disimpan di folder state: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 && !strings.Contains(strings.ToLower(os.Getenv("OS")), "windows") {
		t.Errorf("baseline harus mode 0600, dapat %v", info.Mode().Perm())
	}
	e.passwd("root:x:0:0:root:/root:/bin/bash", "ubuntu:x:1000:1000::/home/ubuntu:/bin/bash", "baru:x:1002:1002::/home/baru:/bin/bash")
	restarted := checkByKey(buildSecurityChecks(cfg, &fakeRun{}), "sec:users") // agen dimulai ulang: baseline lama dipakai
	if r := restarted.Run(ctx); r.Lvl() != LevelCritical || !strings.Contains(r.Detail, "baru") {
		t.Fatalf("perubahan yang terjadi selama agen mati tetap terdeteksi: %+v", r)
	}
}

func TestSecurityEventsThroughAgent(t *testing.T) {
	e := newSecEnv(t)
	app := newFakeApp(t)
	sys := &fakeSys{cores: 4, load: 0.5, mem: 60, disk: 40, psi: 1, psiOK: true}
	a := newTestAgent(t, app, func(c *Config) {
		c.Security = secCfg(t, func(s *Security) { s.SSHFailCrit = 3; s.Watch = []string{"users"} }).Security
	}, sys, &fakeRun{outs: map[string]string{"last ": "ubuntu pts/0", "getent": "root:0:/bin/bash"}})
	ctx := context.Background()
	for i := 0; i < 200; i++ { // keadaan normal: tidak ada kejadian
		a.Tick(ctx)
	}
	a.Flush(ctx)
	if n := len(app.evs()); n != 0 {
		t.Fatalf("keadaan normal tidak boleh mengirim apa pun, dapat %d", n)
	}
	for i := 0; i < 4; i++ {
		e.logLine(fmt.Sprintf("host sshd[1]: Failed password for root from 203.0.113.9 port %d ssh2", 1000+i))
	}
	for i := 0; i < 5; i++ {
		a.Tick(ctx)
	}
	a.Flush(ctx)
	evs := app.evs()
	if len(evs) != 1 || evs[0].Key != "sec:ssh_fail" || evs[0].Kind != "security" || evs[0].Type != "open" || evs[0].Severity != "critical" {
		t.Fatalf("seharusnya satu kejadian open bertipe security: %+v", evs)
	}
	if !strings.Contains(evs[0].Detail, "203.0.113.9") || len(evs[0].Diag) == 0 {
		t.Fatalf("kejadian membawa sumber teratas dan diagnostik: %+v", evs[0])
	}
}

func TestSecurityCheckKeysAreStableAndKindIsSecurity(t *testing.T) {
	newSecEnv(t)
	cs := buildSecurityChecks(secCfg(t, func(s *Security) { s.RootLogin = true }), &fakeRun{})
	var keys []string
	for _, c := range cs {
		keys = append(keys, c.Key)
		if c.Kind != "security" || c.Title == "" || len(c.Diag) == 0 {
			t.Errorf("%s: kind, judul, dan diagnostik wajib", c.Key)
		}
	}
	want := "sec:ssh_fail sec:root_login sec:users sec:keys sec:sudoers sec:sshd sec:ports"
	if strings.Join(keys, " ") != want {
		t.Fatalf("kunci/urutan: %v", keys)
	}
}

func TestSecurityEventLevelsComeFromAppAndDefaultsMakeSense(t *testing.T) {
	e := newSecEnv(t)
	cfg := secCfg(t, func(s *Security) { s.SSHFailCrit = 0; s.RootLogin = true })
	cfg.tune = &Tuning{}
	cs := buildSecurityChecks(cfg, &fakeRun{})
	ctx := context.Background()
	for _, c := range cs {
		c.Run(ctx) // baseline
	}
	e.passwd("root:x:0:0:root:/root:/bin/bash", "ubuntu:x:1000:1000::/home/ubuntu:/bin/bash", "baru:x:1002:1002::/home/baru:/bin/bash")
	e.write(secPaths.SSHDConfig, "PermitRootLogin yes\n")
	e.tcp("0100007F:0CEA", "00000000:0016", "00000000:1F91")
	lvl := func(key string) Level { return checkByKey(cs, key).Run(ctx).Lvl() }
	if lvl("sec:users") != LevelCritical || lvl("sec:sshd") != LevelMajor || lvl("sec:ports") != LevelMajor {
		t.Fatal("bawaan: akun baru critical, sshd dan port baru major")
	}
	cfg.tune.Set(RemoteConfig{Version: "v2", Events: map[string]string{"sec:users": "minor", "sec:ports": "info"}})
	if lvl("sec:users") != LevelMinor || lvl("sec:ports") != LevelInfo || lvl("sec:sshd") != LevelMajor {
		t.Fatal("tingkat kejadian mengikuti halaman Standar; yang tidak disebut tetap bawaan")
	}
}

func TestSSHFailUsesThreeRemoteLimits(t *testing.T) {
	e := newSecEnv(t)
	cfg := secCfg(t, func(s *Security) { s.SSHFailCrit = 30; s.SSHFailWindowS = 600; s.Watch = []string{"users"} })
	cfg.tune = &Tuning{}
	cfg.tune.Set(RemoteConfig{Version: "v3", Limits: map[string]Limit{"ssh_fail": {Minor: ptr(3), Major: ptr(6), Critical: ptr(10)}}})
	c := checkByKey(buildSecurityChecks(cfg, &fakeRun{}), "sec:ssh_fail")
	ctx := context.Background()
	c.Run(ctx)
	add := func(n int) {
		for i := 0; i < n; i++ {
			e.logLine("host sshd[1]: Failed password for root from 203.0.113.9 port 4000 ssh2")
		}
	}
	add(2)
	if r := c.Run(ctx); r.Lvl() != LevelOK {
		t.Fatalf("2 gagal di bawah Minor: %+v", r)
	}
	add(2)
	if r := c.Run(ctx); r.Lvl() != LevelMinor {
		t.Fatalf("4 gagal = Minor: %+v", r)
	}
	add(3)
	if r := c.Run(ctx); r.Lvl() != LevelMajor {
		t.Fatalf("7 gagal = Major: %+v", r)
	}
	add(4)
	if r := c.Run(ctx); r.Lvl() != LevelCritical || !strings.Contains(r.Detail, "CRITICAL di atas 10 kali") {
		t.Fatalf("11 gagal = Critical dan keterangan menyebut batasnya: %+v", r)
	}
}

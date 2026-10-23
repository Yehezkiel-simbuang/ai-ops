package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Pemeriksaan keamanan yang berjalan DI server, hanya membaca, dan hanya melapor yang genting:
//   - login SSH gagal berulang (dugaan brute force) dan login root yang berhasil, dihitung dalam jendela waktu;
//   - perubahan pada hal yang jarang berubah: akun yang bisa login, authorized_keys, sudoers, sshd_config, dan port yang mendengarkan.
// Perubahan dibandingkan dengan keadaan dasar (baseline) yang dicatat saat agen pertama kali berjalan: keadaan saat itu dianggap sah.
// Isi kunci atau berkas tidak pernah dikirim; hanya nama akun, nama berkas, dan nomor port.

// securityClock dan secPaths dipisah supaya bisa diganti saat uji.
var securityClock = time.Now

type secFiles struct {
	Passwd, Sudoers, SudoersD, SSHDConfig, SSHDConfigD, ProcTCP, ProcTCP6, AuthLog1, AuthLog2 string
	HomePrefix                                                                                string // awalan untuk folder rumah (kosong di server sungguhan)
}

var secPaths = secFiles{"/etc/passwd", "/etc/sudoers", "/etc/sudoers.d", "/etc/ssh/sshd_config", "/etc/ssh/sshd_config.d", "/proc/net/tcp", "/proc/net/tcp6", "/var/log/auth.log", "/var/log/secure", ""}

var validWatch = map[string]bool{"users": true, "keys": true, "sudoers": true, "sshd": true, "ports": true}

// Security adalah bagian konfigurasi. Bawaan: mati (agen lama tidak berubah perilakunya).
type Security struct {
	Enabled        bool     `json:"enabled"`
	SSHFailCrit    int      `json:"ssh_fail_crit"`           // kritis bila login gagal dalam jendela >= angka ini (0 = mati)
	SSHFailWindowS int      `json:"ssh_fail_window_seconds"` // lebar jendela
	RootLogin      bool     `json:"root_login_crit"`         // kritis bila ada login root yang berhasil lewat SSH (mati bawaan: banyak server memang memakainya)
	Watch          []string `json:"watch"`                   // users, keys, sudoers, sshd, ports (kosong = semuanya)
	HoldMinutes    int      `json:"hold_minutes"`            // lama perubahan dilaporkan sebelum dianggap sah dan menjadi baseline baru
	AuthLog        string   `json:"auth_log"`                // berkas log login; kosong = cari otomatis, lalu journalctl
}

func (s *Security) validate() error {
	if !s.Enabled {
		return nil
	}
	if s.SSHFailCrit < 0 || s.SSHFailCrit > 100000 {
		return fmt.Errorf("security.ssh_fail_crit 0..100000")
	}
	if s.SSHFailWindowS < 60 || s.SSHFailWindowS > 86400 {
		return fmt.Errorf("security.ssh_fail_window_seconds 60..86400")
	}
	if s.HoldMinutes < 5 || s.HoldMinutes > 10080 {
		return fmt.Errorf("security.hold_minutes 5..10080")
	}
	for _, w := range s.Watch {
		if !validWatch[w] {
			return fmt.Errorf("security.watch tidak dikenal: %q (pilihan: users, keys, sudoers, sshd, ports)", w)
		}
	}
	return nil
}

func (s Security) watching(name string) bool {
	if len(s.Watch) == 0 {
		return true
	}
	for _, w := range s.Watch {
		if w == name {
			return true
		}
	}
	return false
}

// ---------- membaca baris baru dari berkas (seperti tail -f): hanya byte baru, benar saat log berotasi

type tailer struct {
	path    string
	offset  int64
	ino     uint64
	started bool
}

// Each memanggil fn untuk tiap baris BARU sejak pemanggilan terakhir. Pembacaan pertama hanya menandai posisi.
func (t *tailer) Each(fn func(string)) error {
	f, err := os.Open(t.path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	cur := fileInode(st)
	if !t.started {
		t.offset, t.ino, t.started = st.Size(), cur, true
		return nil
	}
	if st.Size() < t.offset || (cur != 0 && t.ino != 0 && cur != t.ino) {
		t.offset = 0
	}
	t.ino = cur
	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return err
	}
	r := bufio.NewReaderSize(io.LimitReader(f, 64<<20), 1<<16)
	for {
		line, err := r.ReadString('\n')
		if line != "" {
			fn(line)
		}
		if err != nil {
			break
		}
	}
	t.offset = st.Size()
	return nil
}

// ---------- login SSH: jendela waktu supaya status kritis bertahan cukup lama untuk dikonfirmasi

var (
	failRe = regexp.MustCompile(`Failed \S+ for |Invalid user `)
	rootRe = regexp.MustCompile(`Accepted \S+ for root from `)
	ipRe   = regexp.MustCompile(`(?:from|rhost=)\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-fA-F]*:[0-9a-fA-F:]+)`)
)

type authSlot struct {
	fails, roots int
	ips          map[string]int
}

type authFeed struct {
	cfg     Security
	run     Runner
	tail    *tailer
	useJour bool
	chosen  bool
	last    time.Time
	slots   []authSlot
	cap     int
	mu      sync.Mutex
}

func newAuthFeed(s Security, run Runner, intervalS int) *authFeed {
	if intervalS < 1 {
		intervalS = 30
	}
	n := (s.SSHFailWindowS + intervalS - 1) / intervalS
	if n < 1 {
		n = 1
	}
	return &authFeed{cfg: s, run: run, cap: n}
}

func (f *authFeed) choose() {
	f.chosen = true
	for _, p := range []string{f.cfg.AuthLog, secPaths.AuthLog1, secPaths.AuthLog2} {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			f.tail = &tailer{path: p}
			return
		}
	}
	f.useJour = true
}

// refresh dipanggil SEKALI per putaran (oleh pemeriksaan pertama): membaca baris login baru dan menggeser jendela.
func (f *authFeed) refresh(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.chosen {
		f.choose()
	}
	slot := authSlot{ips: map[string]int{}}
	eat := func(line string) {
		if failRe.MatchString(line) {
			slot.fails++
			if m := ipRe.FindStringSubmatch(line); m != nil {
				slot.ips[m[1]]++
			}
		}
		if rootRe.MatchString(line) {
			slot.roots++
		}
	}
	now := securityClock()
	switch {
	case f.tail != nil:
		if err := f.tail.Each(eat); err != nil {
			return err
		}
	default:
		if f.last.IsZero() {
			f.last = now
		} else {
			out, _, err := f.run.Run(ctx, "journalctl -u ssh -u sshd --since @"+strconv.FormatInt(f.last.Unix(), 10)+" --no-pager -o cat 2>/dev/null", 10*time.Second)
			if err != nil && strings.TrimSpace(out) == "" {
				return fmt.Errorf("tidak bisa membaca log login (berkas auth.log atau journalctl): %w", err)
			}
			for _, l := range strings.Split(out, "\n") {
				eat(l)
			}
			f.last = now
		}
	}
	f.slots = append(f.slots, slot)
	if len(f.slots) > f.cap {
		f.slots = f.slots[len(f.slots)-f.cap:]
	}
	return nil
}

func (f *authFeed) sums() (fails, roots int, top string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ips := map[string]int{}
	for _, s := range f.slots {
		fails += s.fails
		roots += s.roots
		for ip, n := range s.ips {
			ips[ip] += n
		}
	}
	type kv struct {
		ip string
		n  int
	}
	var list []kv
	for ip, n := range ips {
		list = append(list, kv{ip, n})
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].n > list[j].n || (list[i].n == list[j].n && list[i].ip < list[j].ip)
	})
	var parts []string
	for i := 0; i < len(list) && i < 3; i++ {
		parts = append(parts, fmt.Sprintf("%s (%dx)", list[i].ip, list[i].n))
	}
	return fails, roots, strings.Join(parts, ", ")
}

func minutes(s int) int {
	if s < 60 {
		return 1
	}
	return s / 60
}

// ---------- perubahan terhadap baseline

type secStore struct {
	path string
	mu   sync.Mutex
	data map[string]map[string]string
}

func newSecStore(dir string) *secStore {
	st := &secStore{data: map[string]map[string]string{}}
	if dir != "" {
		st.path = filepath.Join(dir, "security-baseline.json")
		if b, err := os.ReadFile(st.path); err == nil {
			_ = json.Unmarshal(b, &st.data)
		}
	}
	return st
}

func (s *secStore) get(key string) (map[string]string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.data[key]
	return m, ok
}

func (s *secStore) set(key string, m map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[key] = m
	if s.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return
	}
	b, _ := json.Marshal(s.data)
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

type watcher struct {
	key       string
	store     *secStore
	hold      time.Duration
	changedAt time.Time
}

func diffItems(base, cur map[string]string) (added, changed []string) {
	for k, v := range cur {
		old, ok := base[k]
		switch {
		case !ok:
			added = append(added, k)
		case old != v:
			changed = append(changed, k)
		}
	}
	sort.Strings(added)
	sort.Strings(changed)
	return
}

// observe: kritis selama keadaan sekarang berbeda dari baseline (ditambah atau diubah) dan belum melewati masa lapor.
// Setelah masa lapor, keadaan sekarang diterima sebagai baseline baru, sehingga insiden menutup sendiri.
func (w *watcher) observe(cur map[string]string, now time.Time) (crit bool, added, changed []string) {
	base, ok := w.store.get(w.key)
	if !ok {
		w.store.set(w.key, cur) // pertama kali: keadaan sekarang dianggap sah
		return false, nil, nil
	}
	added, changed = diffItems(base, cur)
	if len(added)+len(changed) == 0 {
		if len(base) != len(cur) { // hanya ada yang dihapus: terima tanpa laporan
			w.store.set(w.key, cur)
		}
		w.changedAt = time.Time{}
		return false, nil, nil
	}
	if w.changedAt.IsZero() {
		w.changedAt = now
	}
	if now.Sub(w.changedAt) >= w.hold {
		w.store.set(w.key, cur)
		w.changedAt = time.Time{}
		return false, nil, nil
	}
	return true, added, changed
}

// ---------- pengumpul keadaan (semua hanya membaca)

func hashBytes(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:8]) }

func hashFile(path string) (string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return hashBytes(b), true
}

func hashFiles(file, dir string) map[string]string {
	out := map[string]string{}
	if h, ok := hashFile(file); ok {
		out[file] = h
	}
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			if e.IsDir() {
				continue
			}
			p := filepath.Join(dir, e.Name())
			if h, ok := hashFile(p); ok {
				out[p] = h
			}
		}
	}
	return out
}

type passwdEntry struct{ name, uid, home, shell string }

func readPasswd() ([]passwdEntry, error) {
	b, err := os.ReadFile(secPaths.Passwd)
	if err != nil {
		return nil, err
	}
	var out []passwdEntry
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Split(strings.TrimSpace(l), ":")
		if len(f) < 7 || strings.HasPrefix(l, "#") {
			continue
		}
		out = append(out, passwdEntry{f[0], f[2], f[5], f[6]})
	}
	return out, nil
}

func canLogin(e passwdEntry) bool {
	if e.uid == "0" {
		return true
	}
	switch e.shell {
	case "", "/usr/sbin/nologin", "/sbin/nologin", "/bin/false", "/usr/bin/false", "/bin/sync":
		return false
	}
	return true
}

func collectUsers() (map[string]string, error) {
	es, err := readPasswd()
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, e := range es {
		if canLogin(e) {
			out[e.name] = e.uid + ":" + e.shell
		}
	}
	return out, nil
}

func collectKeys() (map[string]string, error) {
	es, err := readPasswd()
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, e := range es {
		if !canLogin(e) || e.home == "" {
			continue
		}
		for _, f := range []string{"authorized_keys", "authorized_keys2"} {
			if h, ok := hashFile(filepath.Join(secPaths.HomePrefix, e.home, ".ssh", f)); ok {
				out[e.name+":"+f] = h
			}
		}
	}
	return out, nil
}

func collectPorts() (map[string]string, error) {
	out := map[string]string{}
	got := false
	for _, p := range []string{secPaths.ProcTCP, secPaths.ProcTCP6} {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		got = true
		sc := bufio.NewScanner(f)
		sc.Scan() // judul kolom
		for sc.Scan() {
			fl := strings.Fields(sc.Text())
			if len(fl) < 4 || fl[3] != "0A" { // 0A = LISTEN
				continue
			}
			addr, port, ok := strings.Cut(fl[1], ":")
			if !ok || isLoopbackHex(addr) {
				continue
			}
			if n, err := strconv.ParseUint(port, 16, 32); err == nil {
				out["tcp/"+strconv.FormatUint(n, 10)] = "listen"
			}
		}
		f.Close()
	}
	if !got {
		return nil, fmt.Errorf("tidak bisa membaca %s", secPaths.ProcTCP)
	}
	return out, nil
}

// isLoopbackHex mengenali alamat loopback pada format /proc/net/tcp: IPv4 127.x.x.x, IPv6 ::1, dan IPv4 yang dipetakan ke IPv6.
func isLoopbackHex(a string) bool {
	switch len(a) {
	case 8:
		return strings.HasSuffix(a, "7F") // urutan byte terbalik: oktet pertama ada di akhir
	case 32:
		return a == "00000000000000000000000001000000" || (strings.HasPrefix(a, "0000000000000000FFFF0000") && strings.HasSuffix(a, "7F"))
	}
	return false
}

func joinNames(xs []string, f func(string) string) string {
	seen := map[string]bool{}
	var out []string
	for _, x := range xs {
		n := f(x)
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return strings.Join(out, ", ")
}

func ident(s string) string { return s }
func before(s string) string {
	a, _, _ := strings.Cut(s, ":")
	return a
}
func portNum(s string) string { return strings.TrimPrefix(s, "tcp/") }

type watchSpec struct {
	name, title string
	collect     func() (map[string]string, error)
	diag        []DiagSpec
	describe    func(added, changed []string) string
}

func watchSpecs() []watchSpec {
	both := func(label string, fn func(string) string) func(a, c []string) string {
		return func(a, c []string) string {
			var parts []string
			if len(a) > 0 {
				parts = append(parts, label+" baru: "+joinNames(a, fn))
			}
			if len(c) > 0 {
				parts = append(parts, label+" berubah: "+joinNames(c, fn))
			}
			return strings.Join(parts, "; ")
		}
	}
	return []watchSpec{
		{"users", "Akun yang bisa login baru atau berubah", collectUsers, []DiagSpec{{"akun yang bisa login", "getent passwd | cut -d: -f1,3,7 | grep -Ev ':(/usr)?/s?bin/(nologin|false)$'"}, {"login terakhir", "last -n 15 -w 2>/dev/null"}}, both("akun", ident)},
		{"keys", "Kunci SSH (authorized_keys) berubah", collectKeys, []DiagSpec{{"berkas kunci", "ls -la /root/.ssh /home/*/.ssh 2>/dev/null | head -40"}, {"login terakhir", "last -n 15 -w 2>/dev/null"}}, both("authorized_keys akun", before)},
		{"sudoers", "Aturan sudo (sudoers) berubah", func() (map[string]string, error) { return hashFiles(secPaths.Sudoers, secPaths.SudoersD), nil }, []DiagSpec{{"berkas sudoers.d", "ls -la /etc/sudoers.d 2>/dev/null"}, {"anggota grup sudo", "getent group sudo wheel 2>/dev/null"}}, both("berkas", ident)},
		{"sshd", "Konfigurasi sshd berubah", func() (map[string]string, error) { return hashFiles(secPaths.SSHDConfig, secPaths.SSHDConfigD), nil }, []DiagSpec{{"berkas konfigurasi", "ls -la /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>/dev/null"}}, both("berkas", ident)},
		{"ports", "Port baru mendengarkan dari luar", collectPorts, []DiagSpec{{"port mendengarkan", "ss -ltnp 2>/dev/null | head -30"}}, func(a, _ []string) string { return "port baru mendengarkan: " + joinNames(a, portNum) }},
	}
}

// defaultEventLevel: tingkat bawaan kejadian perubahan; bisa diubah dari halaman Standar. Akun, kunci SSH, dan sudo = pintu masuk baru, jadi critical.
func defaultEventLevel(name string) Level {
	switch name {
	case "users", "keys", "sudoers":
		return LevelCritical
	}
	return LevelMajor
}

// buildSecurityChecks menyusun pemeriksaan keamanan bila diaktifkan. Pemeriksaan login pertama membaca log untuk semuanya,
// jadi urutan di sini penting: yang memanggil refresh harus yang pertama.
func buildSecurityChecks(cfg Config, run Runner) []*Check {
	s := cfg.Security
	if !s.Enabled {
		return nil
	}
	var cs []*Check
	diagLogin := []DiagSpec{{"login terakhir", "last -n 20 -w 2>/dev/null"}, {"koneksi SSH aktif", "ss -tn state established '( sport = :22 )' 2>/dev/null | head -20"}}
	if s.SSHFailCrit > 0 || s.RootLogin {
		feed := newAuthFeed(s, run, cfg.IntervalSeconds)
		needRefresh := true // hanya pemeriksaan login yang PERTAMA disusun yang membaca log; yang kedua memakai hasilnya
		lead := func() bool { r := needRefresh; needRefresh = false; return r }
		if s.SSHFailCrit > 0 {
			leads := lead()
			cs = append(cs, &Check{Key: "sec:ssh_fail", Title: "Login SSH gagal berulang (dugaan brute force)", Kind: "security", Diag: diagLogin,
				Run: func(ctx context.Context) Result {
					if leads {
						if err := feed.refresh(ctx); err != nil {
							return Result{Unknown: true, Detail: err.Error()}
						}
					}
					fails, _, top := feed.sums()
					lv, th := cfg.tune.Limit("ssh_fail", Limit{Critical: ptr(float64(s.SSHFailCrit))}).Eval(float64(fails), "gt")
					d := fmt.Sprintf("%d login SSH gagal dalam %d menit", fails, minutes(s.SSHFailWindowS)) + over(lv, th, "gt", " kali")
					if top != "" && fails > 0 {
						d += "; sumber teratas: " + top
					}
					return Result{Level: lv, Value: float64(fails), HasValue: true, Detail: d}
				}})
		}
		if s.RootLogin {
			leads := lead()
			cs = append(cs, &Check{Key: "sec:root_login", Title: "Login root lewat SSH berhasil", Kind: "security", Diag: diagLogin,
				Run: func(ctx context.Context) Result {
					if leads {
						if err := feed.refresh(ctx); err != nil {
							return Result{Unknown: true, Detail: err.Error()}
						}
					}
					_, roots, _ := feed.sums()
					lv := LevelOK
					if roots > 0 {
						lv = cfg.tune.Event("sec:root_login", LevelMajor)
					}
					return Result{Level: lv, Value: float64(roots), HasValue: true, Detail: fmt.Sprintf("%d login root berhasil dalam %d menit terakhir", roots, minutes(s.SSHFailWindowS))}
				}})
		}
	}
	store := newSecStore(cfg.StateDir)
	for _, sp := range watchSpecs() {
		sp := sp
		if !s.watching(sp.name) {
			continue
		}
		w := &watcher{key: sp.name, store: store, hold: time.Duration(s.HoldMinutes) * time.Minute}
		cs = append(cs, &Check{Key: "sec:" + sp.name, Title: sp.title, Kind: "security", Diag: sp.diag,
			Run: func(context.Context) Result {
				cur, err := sp.collect()
				if err != nil {
					return Result{Unknown: true, Detail: err.Error()}
				}
				crit, added, changed := w.observe(cur, securityClock())
				if !crit {
					return Result{}
				}
				return Result{Level: cfg.tune.Event("sec:"+sp.name, defaultEventLevel(sp.name)), Detail: sp.describe(added, changed) + fmt.Sprintf(" (dibandingkan dengan keadaan saat agen pertama berjalan; dianggap sah lagi setelah %d menit)", int(w.hold/time.Minute))}
			}})
	}
	return cs
}

package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Result adalah hasil satu pemeriksaan. Level = tingkat kondisi saat ini (LevelOK = normal); Crit tetap ada untuk pemeriksaan sederhana (true = critical).
type Result struct {
	Crit     bool
	Level    Level
	Value    float64
	HasValue bool
	Detail   string
	Unknown  bool // gagal mengukur: tidak dihitung sebagai kritis
}

// Lvl adalah tingkat efektif: Level bila diisi, jika tidak critical bila Crit.
func (r Result) Lvl() Level {
	if r.Level != LevelOK {
		return r.Level
	}
	if r.Crit {
		return LevelCritical
	}
	return LevelOK
}

// over menambahkan batas yang terlewati ke keterangan, mis. " (Major di atas 1.5 x core)".
func over(lv Level, th float64, dir, unit string) string {
	if lv == LevelOK {
		return ""
	}
	w := "di atas"
	if dir == "lt" {
		w = "di bawah"
	}
	return fmt.Sprintf(" (%s %s %s%s)", lv.Label(), w, fmtF(round2(th)), unit)
}

type DiagSpec struct{ Name, Cmd string }

type Check struct {
	Key, Title, Kind string
	Run              func(ctx context.Context) Result
	Diag             []DiagSpec
}

// Runner menjalankan perintah shell (dipalsukan saat uji).
type Runner interface {
	Run(ctx context.Context, cmd string, timeout time.Duration) (stdout string, exit int, err error)
}

var numRe = regexp.MustCompile(`-?\d+(?:\.\d+)?`)

func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func fmtF(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// BuildChecks menyusun pemeriksaan dari konfigurasi. Hanya ambang kritis yang diperiksa.
func BuildChecks(cfg Config, sys Sys, run Runner) []*Check {
	var cs []*Check
	t := cfg.Thresholds
	cores := float64(sys.Cores())
	if cores < 1 {
		cores = 1
	}
	if t.LoadPerCoreCrit > 0 {
		cs = append(cs, &Check{Key: "load", Title: "Beban CPU kritis", Kind: "load", Diag: []DiagSpec{{"uptime", "uptime"}, {"proses teratas (CPU)", "ps -eo pid,pcpu,pmem,stat,comm --sort=-pcpu | head -8"}},
			Run: func(context.Context) Result {
				v, err := sys.Load5()
				if err != nil {
					return Result{Unknown: true, Detail: err.Error()}
				}
				lv, th := cfg.tune.Limit("load", Limit{Critical: ptr(t.LoadPerCoreCrit)}).Eval(v/cores, "gt")
				return Result{Level: lv, Value: v, HasValue: true, Detail: fmt.Sprintf("load 5 menit %s pada %d core", fmtF(round2(v)), int(cores)) + over(lv, th, "gt", " x core")}
			}})
	}
	if t.MemAvailPctCrit > 0 {
		cs = append(cs, &Check{Key: "mem", Title: "Memori tersedia hampir habis", Kind: "mem", Diag: []DiagSpec{{"free -m", "free -m"}, {"proses teratas (memori)", "ps -eo pid,pmem,rss,comm --sort=-pmem | head -8"}},
			Run: func(context.Context) Result {
				v, err := sys.MemAvailPct()
				if err != nil {
					return Result{Unknown: true, Detail: err.Error()}
				}
				lv, th := cfg.tune.Limit("mem", Limit{Critical: ptr(t.MemAvailPctCrit)}).Eval(v, "lt")
				return Result{Level: lv, Value: v, HasValue: true, Detail: fmt.Sprintf("memori tersedia %s%%", fmtF(round2(v))) + over(lv, th, "lt", "%")}
			}})
	}
	if t.DiskPctCrit > 0 {
		path := t.DiskPath
		if path == "" {
			path = "/"
		}
		cs = append(cs, &Check{Key: "disk:" + path, Title: "Disk " + path + " hampir penuh", Kind: "disk", Diag: []DiagSpec{{"df -h", "df -h | head -15"}, {"direktori terbesar", "du -xk -d1 " + shq(path) + " 2>/dev/null | sort -rn | head -8"}},
			Run: func(context.Context) Result {
				v, err := sys.DiskPct(path)
				if err != nil {
					return Result{Unknown: true, Detail: err.Error()}
				}
				lv, th := cfg.tune.Limit("disk", Limit{Critical: ptr(t.DiskPctCrit)}).Eval(v, "gt")
				return Result{Level: lv, Value: v, HasValue: true, Detail: fmt.Sprintf("%s terpakai %s%%", path, fmtF(round2(v))) + over(lv, th, "gt", "%")}
			}})
	}
	if t.IOPsiCrit > 0 {
		cs = append(cs, &Check{Key: "io", Title: "Tekanan I/O disk kritis", Kind: "io", Diag: []DiagSpec{{"PSI io", "cat /proc/pressure/io"}, {"proses menunggu I/O (D)", "ps -eo pid,stat,wchan:20,comm | awk '$2 ~ /^D/' | head -10"}, {"iostat", "iostat -x 1 2 2>/dev/null | tail -20"}},
			Run: func(context.Context) Result {
				v, ok, err := sys.IOPsi()
				if err != nil {
					return Result{Unknown: true, Detail: err.Error()}
				}
				if !ok {
					return Result{Unknown: true, Detail: "PSI tidak tersedia"}
				}
				lv, th := cfg.tune.Limit("io", Limit{Critical: ptr(t.IOPsiCrit)}).Eval(v, "gt")
				return Result{Level: lv, Value: v, HasValue: true, Detail: fmt.Sprintf("PSI io (some) 10 dtk = %s%%", fmtF(round2(v))) + over(lv, th, "gt", "%")}
			}})
	}
	for _, s := range cfg.Services {
		s := s
		svcLevel := ParseLevel(cfg.ServiceLevels[s], LevelCritical)
		cs = append(cs, &Check{Key: "svc:" + s, Title: "Layanan " + s + " tidak aktif", Kind: "service", Diag: []DiagSpec{{"systemctl status", "systemctl status " + shq(s) + " --no-pager -n 15"}, {"journal", "journalctl -u " + shq(s) + " -n 30 --no-pager"}},
			Run: func(ctx context.Context) Result {
				out, _, err := run.Run(ctx, "systemctl is-active "+shq(s), 5*time.Second)
				st := strings.TrimSpace(out)
				if err != nil && st == "" {
					return Result{Unknown: true, Detail: err.Error()}
				}
				res := Result{Detail: "status: " + st}
				if st != "active" {
					res.Level = svcLevel
				}
				return res
			}})
	}
	for _, p := range cfg.Ports {
		p := p
		portLevel := ParseLevel(p.Level, LevelCritical)
		cs = append(cs, &Check{Key: "port:" + strconv.Itoa(p.Port), Title: "Port " + strconv.Itoa(p.Port) + " (" + p.Name + ") tidak terbuka", Kind: "port", Diag: []DiagSpec{{"port mendengarkan", "ss -ltnp 2>/dev/null | head -20"}},
			Run: func(ctx context.Context) Result {
				d := net.Dialer{Timeout: 3 * time.Second}
				c, err := d.DialContext(ctx, "tcp", "127.0.0.1:"+strconv.Itoa(p.Port))
				if err != nil {
					return Result{Level: portLevel, Detail: "tidak bisa terhubung ke 127.0.0.1:" + strconv.Itoa(p.Port)}
				}
				c.Close()
				return Result{}
			}})
	}
	for _, h := range cfg.HTTP {
		h := h
		httpLevel := ParseLevel(h.Level, LevelCritical)
		lo, hi := h.MinCode, h.MaxCode
		if lo == 0 {
			lo = 200
		}
		if hi == 0 {
			hi = 399
		}
		cs = append(cs, &Check{Key: "http:" + h.Name, Title: "HTTP " + h.Name + " bermasalah", Kind: "http", Diag: []DiagSpec{{"port mendengarkan", "ss -ltn 2>/dev/null | head -12"}},
			Run: func(ctx context.Context) Result {
				cl := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.URL, nil)
				if err != nil {
					return Result{Unknown: true, Detail: err.Error()}
				}
				t0 := time.Now()
				resp, err := cl.Do(req)
				ms := float64(time.Since(t0).Milliseconds())
				if err != nil {
					return Result{Level: httpLevel, Detail: "tidak ada jawaban: " + trimErr(err)}
				}
				io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
				resp.Body.Close()
				if resp.StatusCode < lo || resp.StatusCode > hi {
					return Result{Level: httpLevel, Value: ms, HasValue: true, Detail: fmt.Sprintf("HTTP %d (%d ms)", resp.StatusCode, int(ms))}
				}
				if lv, _ := optLimit(float64(h.MinorMs), float64(h.MajorMs), float64(h.CritMs)).Eval(ms, "gt"); lv != LevelOK {
					return Result{Level: lv, Value: ms, HasValue: true, Detail: fmt.Sprintf("HTTP %d lambat: %d ms", resp.StatusCode, int(ms))}
				}
				return Result{Value: ms, HasValue: true}
			}})
	}
	for _, l := range cfg.Logs {
		cs = append(cs, newLogCheck(l))
	}
	for _, c := range cfg.Commands {
		c := c
		cs = append(cs, &Check{Key: "cmd:" + c.Name, Title: c.Name + " kritis", Kind: "command",
			Run: func(ctx context.Context) Result {
				out, _, err := run.Run(ctx, c.Cmd, 20*time.Second)
				m := numRe.FindString(out)
				if m == "" {
					d := strings.TrimSpace(out)
					if err != nil {
						d = err.Error()
					}
					return Result{Unknown: true, Detail: "tidak ada angka: " + clipStr(d, 120)}
				}
				v, _ := strconv.ParseFloat(m, 64)
				dir := "gt"
				if c.Dir == "lt" {
					dir = "lt"
				}
				lv, _ := Limit{Minor: c.Minor, Major: c.Major, Critical: ptr(c.Crit)}.Eval(v, dir)
				return Result{Level: lv, Value: v, HasValue: true, Detail: fmt.Sprintf("nilai %s (batas Critical %s)", fmtF(round2(v)), fmtF(c.Crit))}
			}})
	}
	cs = append(cs, buildSecurityChecks(cfg, run)...)
	return cs
}

// newLogCheck membaca hanya byte baru sejak pemeriksaan lalu (seperti tail -f), jadi murah walau log besar,
// dan benar saat log berotasi (ukuran mengecil -> mulai dari awal). Pembacaan pertama hanya menandai posisi.
func newLogCheck(l LogCheck) *Check {
	t := &tailer{path: l.Path}
	return &Check{Key: "log:" + l.Name, Title: l.Name + " melonjak", Kind: "log", Diag: []DiagSpec{{"log terakhir", "tail -n 15 " + shq(l.Path)}},
		Run: func(context.Context) Result {
			n := 0
			if err := t.Each(func(line string) {
				if strings.Contains(line, l.Pattern) {
					n++
				}
			}); err != nil {
				return Result{Unknown: true, Detail: err.Error()}
			}
			lv, _ := optLimit(l.MinorDelta, l.MajorDelta, l.CritDelta).Eval(float64(n), "gt")
			return Result{Level: lv, Value: float64(n), HasValue: true, Detail: fmt.Sprintf("%d kemunculan baru \"%s\" (batas %s)", n, clipStr(l.Pattern, 40), fmtF(l.CritDelta))}
		}}
}

func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }
func clipStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
func trimErr(err error) string { return clipStr(strings.ReplaceAll(err.Error(), "\n", " "), 120) }

// ---------- mesin status: tingkat baru dilaporkan setelah `confirm` kali berturut-turut, pulih setelah `recover` kali normal.
// Perubahan tingkat saat sudah terbuka (naik atau turun) dilaporkan sebagai "open" lagi dengan tingkat baru.

type CheckState struct {
	fails, oks   int
	pending      Level // tingkat yang sedang dihitung berturut-turut
	Open         bool
	Cur          Level // tingkat yang sudah dilaporkan
	Last         Level // tingkat terakhir yang dilaporkan (tetap terisi setelah pulih, untuk kejadian "resolved")
	lastAnnounce time.Time
}

const (
	TransNone      = ""
	TransOpen      = "open"
	TransResolved  = "resolved"
	TransStillOpen = "still_open"
)

func (s *CheckState) Observe(r Result, confirm, recover int, reannounce time.Duration, now time.Time) string {
	if r.Unknown { // gagal mengukur tidak mengubah status (tidak memicu kritis palsu, tidak menyatakan pulih)
		return TransNone
	}
	if lv := r.Lvl(); lv != LevelOK {
		s.oks = 0
		if lv == s.pending {
			s.fails++
		} else {
			s.pending, s.fails = lv, 1
		}
		switch {
		case !s.Open && s.fails >= confirm:
			s.Open, s.Cur, s.Last, s.lastAnnounce = true, lv, lv, now
			return TransOpen
		case s.Open && lv != s.Cur && s.fails >= confirm:
			s.Cur, s.Last, s.lastAnnounce = lv, lv, now
			return TransOpen
		case s.Open && lv == s.Cur && reannounce > 0 && now.Sub(s.lastAnnounce) >= reannounce:
			s.lastAnnounce = now
			return TransStillOpen
		}
		return TransNone
	}
	s.fails, s.pending = 0, LevelOK
	if s.Open {
		s.oks++
		if s.oks >= recover {
			s.Open, s.Cur, s.oks = false, LevelOK, 0
			return TransResolved
		}
	}
	return TransNone
}

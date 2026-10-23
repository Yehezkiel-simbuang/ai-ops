package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Result adalah hasil satu pemeriksaan. Crit = kondisi kritis saat ini.
type Result struct {
	Crit     bool
	Value    float64
	HasValue bool
	Detail   string
	Unknown  bool // gagal mengukur: tidak dihitung sebagai kritis
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
				return Result{Crit: v/cores >= t.LoadPerCoreCrit, Value: v, HasValue: true, Detail: fmt.Sprintf("load 5 menit %s pada %d core", fmtF(round2(v)), int(cores))}
			}})
	}
	if t.MemAvailPctCrit > 0 {
		cs = append(cs, &Check{Key: "mem", Title: "Memori tersedia hampir habis", Kind: "mem", Diag: []DiagSpec{{"free -m", "free -m"}, {"proses teratas (memori)", "ps -eo pid,pmem,rss,comm --sort=-pmem | head -8"}},
			Run: func(context.Context) Result {
				v, err := sys.MemAvailPct()
				if err != nil {
					return Result{Unknown: true, Detail: err.Error()}
				}
				return Result{Crit: v <= t.MemAvailPctCrit, Value: v, HasValue: true, Detail: fmt.Sprintf("memori tersedia %s%%", fmtF(round2(v)))}
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
				return Result{Crit: v >= t.DiskPctCrit, Value: v, HasValue: true, Detail: fmt.Sprintf("%s terpakai %s%%", path, fmtF(round2(v)))}
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
				return Result{Crit: v >= t.IOPsiCrit, Value: v, HasValue: true, Detail: fmt.Sprintf("PSI io (some) 10 dtk = %s%%", fmtF(round2(v)))}
			}})
	}
	for _, s := range cfg.Services {
		s := s
		cs = append(cs, &Check{Key: "svc:" + s, Title: "Layanan " + s + " tidak aktif", Kind: "service", Diag: []DiagSpec{{"systemctl status", "systemctl status " + shq(s) + " --no-pager -n 15"}, {"journal", "journalctl -u " + shq(s) + " -n 30 --no-pager"}},
			Run: func(ctx context.Context) Result {
				out, _, err := run.Run(ctx, "systemctl is-active "+shq(s), 5*time.Second)
				st := strings.TrimSpace(out)
				if err != nil && st == "" {
					return Result{Unknown: true, Detail: err.Error()}
				}
				return Result{Crit: st != "active", Detail: "status: " + st}
			}})
	}
	for _, p := range cfg.Ports {
		p := p
		cs = append(cs, &Check{Key: "port:" + strconv.Itoa(p.Port), Title: "Port " + strconv.Itoa(p.Port) + " (" + p.Name + ") tidak terbuka", Kind: "port", Diag: []DiagSpec{{"port mendengarkan", "ss -ltnp 2>/dev/null | head -20"}},
			Run: func(ctx context.Context) Result {
				d := net.Dialer{Timeout: 3 * time.Second}
				c, err := d.DialContext(ctx, "tcp", "127.0.0.1:"+strconv.Itoa(p.Port))
				if err != nil {
					return Result{Crit: true, Detail: "tidak bisa terhubung ke 127.0.0.1:" + strconv.Itoa(p.Port)}
				}
				c.Close()
				return Result{}
			}})
	}
	for _, h := range cfg.HTTP {
		h := h
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
					return Result{Crit: true, Detail: "tidak ada jawaban: " + trimErr(err)}
				}
				io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
				resp.Body.Close()
				if resp.StatusCode < lo || resp.StatusCode > hi {
					return Result{Crit: true, Value: ms, HasValue: true, Detail: fmt.Sprintf("HTTP %d (%d ms)", resp.StatusCode, int(ms))}
				}
				if h.CritMs > 0 && ms >= float64(h.CritMs) {
					return Result{Crit: true, Value: ms, HasValue: true, Detail: fmt.Sprintf("HTTP %d lambat: %d ms", resp.StatusCode, int(ms))}
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
				crit := v >= c.Crit
				if c.Dir == "lt" {
					crit = v <= c.Crit
				}
				return Result{Crit: crit, Value: v, HasValue: true, Detail: fmt.Sprintf("nilai %s (batas kritis %s)", fmtF(round2(v)), fmtF(c.Crit))}
			}})
	}
	return cs
}

// newLogCheck membaca hanya byte baru sejak pemeriksaan lalu (seperti tail -f), jadi murah walau log besar,
// dan benar saat log berotasi (ukuran mengecil -> mulai dari awal). Pembacaan pertama hanya menandai posisi.
func newLogCheck(l LogCheck) *Check {
	var offset int64 = -1
	var ino uint64
	return &Check{Key: "log:" + l.Name, Title: l.Name + " melonjak", Kind: "log", Diag: []DiagSpec{{"log terakhir", "tail -n 15 " + shq(l.Path)}},
		Run: func(context.Context) Result {
			f, err := os.Open(l.Path)
			if err != nil {
				return Result{Unknown: true, Detail: err.Error()}
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil {
				return Result{Unknown: true, Detail: err.Error()}
			}
			cur := fileInode(st)
			if offset < 0 {
				offset, ino = st.Size(), cur
				return Result{Value: 0, HasValue: true}
			}
			if st.Size() < offset || (cur != 0 && ino != 0 && cur != ino) {
				offset = 0
			}
			ino = cur
			if _, err := f.Seek(offset, io.SeekStart); err != nil {
				return Result{Unknown: true, Detail: err.Error()}
			}
			n := 0
			r := bufio.NewReaderSize(io.LimitReader(f, 64<<20), 1<<16)
			for {
				line, err := r.ReadString('\n')
				if strings.Contains(line, l.Pattern) {
					n++
				}
				if err != nil {
					break
				}
			}
			offset = st.Size()
			return Result{Crit: l.CritDelta > 0 && float64(n) >= l.CritDelta, Value: float64(n), HasValue: true, Detail: fmt.Sprintf("%d kemunculan baru \"%s\" (batas %s)", n, clipStr(l.Pattern, 40), fmtF(l.CritDelta))}
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

// ---------- mesin status: kritis hanya setelah `confirm` kali berturut-turut, pulih setelah `recover` kali normal

type CheckState struct {
	fails, oks   int
	Open         bool
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
	if r.Crit {
		s.oks = 0
		s.fails++
		if !s.Open && s.fails >= confirm {
			s.Open, s.lastAnnounce = true, now
			return TransOpen
		}
		if s.Open && reannounce > 0 && now.Sub(s.lastAnnounce) >= reannounce {
			s.lastAnnounce = now
			return TransStillOpen
		}
		return TransNone
	}
	s.fails = 0
	if s.Open {
		s.oks++
		if s.oks >= recover {
			s.Open, s.oks = false, 0
			return TransResolved
		}
	}
	return TransNone
}

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Event adalah satu-satunya jenis data yang dikirim agen selain detak jantung: perubahan status (tingkat info, minor, major, critical).
type Event struct {
	ID       string    `json:"id"`
	Type     string    `json:"type"` // open | still_open | resolved
	Key      string    `json:"key"`
	Title    string    `json:"title"`
	Kind     string    `json:"kind"`
	Severity string    `json:"severity"` // info | minor | major | critical
	Value    *float64  `json:"value,omitempty"`
	Detail   string    `json:"detail"`
	TS       int64     `json:"ts"`
	Diag     []DiagOut `json:"diag,omitempty"`
}

type Agent struct {
	cfg      Config
	checks   []*Check
	states   map[string]*CheckState
	run      Runner
	client   *Client
	spool    *Spool
	exec     *Executor
	now      func() time.Time
	logf     *log.Logger
	hostname string
	version  string
	started  time.Time
	sys      Sys
	tune     *Tuning

	mu         sync.Mutex
	failN      int
	nextTry    time.Time
	pollWake   chan struct{}
	pollWanted bool
}

func NewAgent(cfg Config, sys Sys, run Runner, client *Client, version string, logf *log.Logger) *Agent {
	host, _ := os.Hostname()
	a := &Agent{cfg: cfg, sys: sys, run: run, client: client, version: version, logf: logf, hostname: host, now: time.Now, started: time.Now(),
		states: map[string]*CheckState{}, pollWake: make(chan struct{}, 1)}
	a.tune = NewTuning(cfg.StateDir)
	cfg.tune, a.cfg = a.tune, cfg
	a.checks = BuildChecks(cfg, sys, run)
	spoolPath := ""
	if cfg.StateDir != "" {
		spoolPath = filepath.Join(cfg.StateDir, "spool.json")
	}
	a.spool = LoadSpool(spoolPath, 200)
	a.exec = NewExecutor(cfg, a.now)
	return a
}

func newID() string { b := make([]byte, 8); _, _ = rand.Read(b); return hex.EncodeToString(b) }

// Tick menjalankan semua pemeriksaan sekali dan memasukkan kejadian (kalau ada perubahan status) ke spool.
func (a *Agent) Tick(ctx context.Context) []Event {
	var evs []Event
	for _, c := range a.checks {
		r := c.Run(ctx)
		st := a.states[c.Key]
		if st == nil {
			st = &CheckState{}
			a.states[c.Key] = st
		}
		tr := st.Observe(r, a.cfg.Confirm, a.cfg.Recover, time.Duration(a.cfg.ReannounceMin)*time.Minute, a.now())
		if tr == TransNone {
			continue
		}
		sev := st.Cur
		if tr == TransResolved {
			sev = st.Last
		}
		e := Event{ID: newID(), Type: tr, Key: c.Key, Title: c.Title, Kind: c.Kind, Severity: sev.String(), Detail: r.Detail, TS: a.now().Unix()}
		if r.HasValue {
			v := r.Value
			e.Value = &v
		}
		if tr == TransOpen { // diagnostik hanya saat mulai kritis
			e.Diag = CollectDiag(ctx, a.run, c.Diag)
		}
		if tr == TransResolved {
			e.Title = c.Title + " (pulih)"
		}
		evs = append(evs, e)
		a.spool.Add(e)
		a.logf.Printf("kejadian %s %s: %s", tr, c.Key, r.Detail)
	}
	a.wakePoll()
	return evs
}

func (a *Agent) openKeys() []string {
	k := []string{} // bukan nil: JSON harus berisi [] (bukan null)
	for key, s := range a.states {
		if s.Open {
			k = append(k, key)
		}
	}
	sort.Strings(k)
	return k
}

// Flush mengirim spool ke aplikasi (maks. 20 per permintaan). Gagal -> backoff eksponensial (maks. 5 menit); 4xx permanen -> dibuang.
func (a *Agent) Flush(ctx context.Context) error {
	a.mu.Lock()
	if a.now().Before(a.nextTry) {
		a.mu.Unlock()
		return nil
	}
	a.mu.Unlock()
	for a.spool.Len() > 0 {
		batch := a.spool.Peek(20)
		body, _ := json.Marshal(map[string]any{"agent": map[string]string{"version": a.version, "host": a.hostname}, "events": batch})
		code, resp, err := a.client.Do(ctx, "POST", "/agent/v1/events", body)
		switch {
		case err != nil:
			return a.backoff(fmt.Errorf("kirim gagal: %w", err))
		case code == 401 || code == 403:
			return a.backoff(fmt.Errorf("kunci ditolak aplikasi (HTTP %d): periksa key_id/secret dan jam server", code))
		case code == 429 || code >= 500 || code == 408:
			return a.backoff(fmt.Errorf("aplikasi sibuk (HTTP %d)", code))
		case code >= 400: // kejadian rusak: buang agar tidak macet selamanya
			a.logf.Printf("kejadian ditolak permanen (HTTP %d): %s", code, clipStr(string(resp), 120))
			a.spool.RemoveFirst(len(batch))
		default:
			a.spool.RemoveFirst(len(batch))
			a.mu.Lock()
			a.failN = 0
			a.mu.Unlock()
		}
	}
	return nil
}

func (a *Agent) backoff(err error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.failN++
	d := 5 * time.Second << min(a.failN-1, 6)
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	a.nextTry = a.now().Add(d)
	return err
}

type heartbeatResp struct {
	OK   bool   `json:"ok"`
	Poll bool   `json:"poll"`
	Cfg  string `json:"cfg"` // versi konfigurasi dari halaman Standar; berbeda dari yang dipegang agen = ambil yang baru
	// Patch: aplikasi meminta fakta pembaruan dilaporkan sekarang (mis. setelah pengguna menerapkan patch), tanpa menunggu putaran berikutnya.
	Patch bool `json:"patch"`
}

// Heartbeat sangat kecil (sekitar 150 byte): hanya memberi tahu aplikasi bahwa agen hidup dan kunci apa yang sedang kritis.
func (a *Agent) Heartbeat(ctx context.Context) error {
	up, _ := a.sys.UptimeSeconds()
	body, _ := json.Marshal(map[string]any{"v": a.version, "host": a.hostname, "up": up, "exec": a.cfg.AllowExec, "open": a.openKeys(), "hb": a.cfg.HeartbeatSeconds})
	code, resp, err := a.client.Do(ctx, "POST", "/agent/v1/heartbeat", body)
	if err != nil {
		return err
	}
	if code != 200 {
		return fmt.Errorf("heartbeat HTTP %d", code)
	}
	var hr heartbeatResp
	_ = json.Unmarshal(resp, &hr)
	a.mu.Lock()
	a.pollWanted = hr.Poll
	a.mu.Unlock()
	a.wakePoll()
	if hr.Patch {
		go func() { // di goroutine: membaca daftar paket bisa makan waktu dan tidak boleh menahan detak jantung
			if err := a.ReportPatch(ctx); err != nil {
				a.logf.Printf("pembaruan: %v", err)
			}
		}()
	}
	if hr.Cfg != "" && hr.Cfg != a.tune.Version() {
		if err := a.SyncConfig(ctx); err != nil {
			a.logf.Printf("konfigurasi dari aplikasi: %v", err)
		}
	}
	return nil
}

// SyncConfig mengambil batas dan tingkat kejadian dari halaman Standar. Gagal = batas yang ada (atau lokal) tetap dipakai.
func (a *Agent) SyncConfig(ctx context.Context) error {
	code, resp, err := a.client.Do(ctx, "GET", "/agent/v1/config", nil)
	if err != nil {
		return err
	}
	if code != 200 {
		return fmt.Errorf("HTTP %d", code)
	}
	var rc RemoteConfig
	if err := json.Unmarshal(resp, &rc); err != nil || rc.Version == "" {
		return fmt.Errorf("konfigurasi tidak terbaca")
	}
	a.tune.Set(rc)
	a.logf.Printf("konfigurasi dari aplikasi diperbarui (versi %s)", rc.Version)
	return nil
}

func (a *Agent) wakePoll() {
	if !a.cfg.AllowExec {
		return
	}
	select {
	case a.pollWake <- struct{}{}:
	default:
	}
}

func (a *Agent) shouldPoll() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pollWanted || len(a.openKeys()) > 0
}

type pollResp struct {
	Commands []Command `json:"commands"`
	Poll     bool      `json:"poll"`
}

// PollOnce mengambil perintah yang sudah disetujui (long-poll sampai 25 detik) dan menjalankannya. Hanya dipanggil bila allow_exec
// aktif DAN ada insiden terbuka atau aplikasi meminta (lewat heartbeat), jadi tanpa insiden tidak ada lalu lintas tambahan.
func (a *Agent) PollOnce(ctx context.Context, wait int) (int, error) {
	code, resp, err := a.client.Do(ctx, "GET", "/agent/v1/commands/poll?wait="+url.QueryEscape(fmt.Sprint(wait)), nil)
	if err != nil {
		return 0, err
	}
	if code != 200 {
		return 0, fmt.Errorf("poll HTTP %d", code)
	}
	var pr pollResp
	if err := json.Unmarshal(resp, &pr); err != nil {
		return 0, err
	}
	a.mu.Lock()
	a.pollWanted = pr.Poll
	a.mu.Unlock()
	for _, c := range pr.Commands {
		res := a.exec.Handle(ctx, c)
		body, _ := json.Marshal(res)
		if code, _, err := a.client.Do(ctx, "POST", "/agent/v1/commands/"+url.PathEscape(c.ID)+"/result", body); err != nil || code >= 300 {
			a.logf.Printf("gagal melaporkan hasil perintah %s (HTTP %d): %v", c.ID, code, err)
		}
	}
	return len(pr.Commands), nil
}

func (a *Agent) pollLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.pollWake:
		}
		for a.shouldPoll() && ctx.Err() == nil {
			n, err := a.PollOnce(ctx, 25)
			if err != nil {
				a.logf.Printf("poll: %v", err)
				select {
				case <-ctx.Done():
					return
				case <-time.After(10 * time.Second):
				}
			} else if n == 0 && !a.shouldPoll() {
				break
			}
		}
	}
}

func (a *Agent) Run(ctx context.Context) {
	a.logf.Printf("agen %s mulai: %d pemeriksaan, interval %ds, heartbeat %ds, eksekusi=%v", a.version, len(a.checks), a.cfg.IntervalSeconds, a.cfg.HeartbeatSeconds, a.cfg.AllowExec)
	if a.cfg.AllowExec {
		go a.pollLoop(ctx)
	}
	tick := time.NewTicker(time.Duration(a.cfg.IntervalSeconds) * time.Second)
	hb := time.NewTicker(time.Duration(a.cfg.HeartbeatSeconds) * time.Second)
	defer tick.Stop()
	defer hb.Stop()
	a.Tick(ctx)
	if err := a.Heartbeat(ctx); err != nil {
		a.logf.Printf("heartbeat: %v", err)
	}
	if err := a.Flush(ctx); err != nil {
		a.logf.Printf("kirim: %v", err)
	}
	go a.patchLoop(ctx)
	for {
		select {
		case <-ctx.Done():
			a.logf.Printf("agen berhenti; %d kejadian belum terkirim tersimpan di spool", a.spool.Len())
			return
		case <-tick.C:
			a.Tick(ctx)
			if err := a.Flush(ctx); err != nil {
				a.logf.Printf("kirim: %v", err)
			}
		case <-hb.C:
			if err := a.Heartbeat(ctx); err != nil {
				a.logf.Printf("heartbeat: %v", err)
			}
		}
	}
}

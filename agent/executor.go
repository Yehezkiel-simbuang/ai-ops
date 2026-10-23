package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Command adalah perintah yang sudah DISETUJUI pengguna di aplikasi dan ditandatangani server.
type Command struct {
	ID       string `json:"id"`
	Command  string `json:"command"`
	TimeoutS int    `json:"timeout_s"`
	Expires  int64  `json:"expires"`
	Sig      string `json:"sig"`
}

type CommandResult struct {
	Exit     int    `json:"exit"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Ms       int64  `json:"ms"`
	Rejected string `json:"rejected,omitempty"` // alasan penolakan oleh agen (tidak dijalankan)
	TimedOut bool   `json:"timed_out,omitempty"`
}

// Executor menjalankan perintah hanya bila: eksekusi diaktifkan di konfigurasi, tanda tangan server valid, belum kedaluwarsa,
// belum pernah dijalankan (anti replay), dan tidak melanggar daftar blokir lokal.
type Executor struct {
	secret    string
	allow     bool
	stateFile string
	now       func() time.Time
	mu        sync.Mutex
	done      []string
}

func NewExecutor(cfg Config, now func() time.Time) *Executor {
	x := &Executor{secret: cfg.Secret, allow: cfg.AllowExec, now: now}
	if cfg.StateDir != "" {
		x.stateFile = filepath.Join(cfg.StateDir, "executed.json")
		if b, err := os.ReadFile(x.stateFile); err == nil {
			_ = json.Unmarshal(b, &x.done)
		}
	}
	return x
}

func (x *Executor) seen(id string) bool {
	for _, d := range x.done {
		if d == id {
			return true
		}
	}
	return false
}
func (x *Executor) remember(id string) {
	x.done = append(x.done, id)
	if len(x.done) > 500 {
		x.done = x.done[len(x.done)-500:]
	}
	if x.stateFile != "" {
		_ = os.MkdirAll(filepath.Dir(x.stateFile), 0o700)
		b, _ := json.Marshal(x.done)
		tmp := x.stateFile + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, x.stateFile)
		}
	}
}

func (x *Executor) Handle(ctx context.Context, c Command) CommandResult {
	x.mu.Lock()
	defer x.mu.Unlock()
	rej := func(why string) CommandResult { return CommandResult{Exit: 126, Rejected: why} }
	switch {
	case !x.allow:
		return rej("eksekusi dimatikan di konfigurasi agen (allow_exec=false)")
	case !VerifyCommandSig(x.secret, c):
		return rej("tanda tangan perintah tidak valid")
	case x.now().Unix() > c.Expires:
		return rej("perintah kedaluwarsa")
	case x.seen(c.ID):
		return rej("perintah ini sudah pernah dijalankan")
	}
	if why, bad := Blocked(c.Command); bad {
		x.remember(c.ID)
		return rej("diblokir kebijakan agen: " + why)
	}
	x.remember(c.ID) // dicatat sebelum jalan: kalau agen mati di tengah, perintah tidak diulang diam-diam
	timeout := time.Duration(c.TimeoutS) * time.Second
	if timeout <= 0 || timeout > 10*time.Minute {
		timeout = 2 * time.Minute
	}
	t0 := time.Now()
	so, se, code, to := execShell(ctx, c.Command, timeout, 12000)
	return CommandResult{Exit: code, Stdout: Redact(so), Stderr: Redact(se), Ms: time.Since(t0).Milliseconds(), TimedOut: to}
}

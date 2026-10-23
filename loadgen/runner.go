package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// execFn menjalankan k6 untuk satu tahap (diganti di tes). Mengembalikan keluaran gabungan untuk pesan galat.
type execFn func(ctx context.Context, bin string, args, env []string) (string, error)

func execReal(ctx context.Context, bin string, args, env []string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), env...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	s := out.String()
	if len(s) > 800 {
		s = s[len(s)-800:]
	}
	return s, err
}

type runner struct {
	api       API
	k6        string
	dir       string
	cpu       cpuReader
	resolve   resolver
	run       execFn
	scrapeHTT *http.Client
	beat      time.Duration // selang heartbeat
	logf      func(string, ...any)
}

func newRunner(api API, k6 string) *runner {
	return &runner{api: api, k6: k6, cpu: cgroupCPU{root: "/sys/fs/cgroup"}, resolve: lookup, run: execReal, scrapeHTT: &http.Client{Timeout: 2 * time.Second}, beat: 10 * time.Second, logf: log.Printf}
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

// runJob menjalankan satu uji: tiap tahap = satu proses k6 dengan jumlah pengguna dan durasi tetap, lalu hasilnya dilaporkan.
// Pembatalan dari aplikasi (lewat balasan heartbeat/stage) menghentikan k6 dan menutup uji sebagai cancelled.
func (r *runner) runJob(ctx context.Context, j *Job) {
	finish := func(status, msg string) {
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		if err := r.api.finish(fctx, j.ID, status, msg); err != nil {
			r.logf("uji %d: gagal menutup (%s): %v", j.ID, status, err)
		}
	}
	if err := checkJob(j, r.resolve); err != nil {
		finish("failed", "Target ditolak runner: "+err.Error())
		return
	}
	dir, err := os.MkdirTemp(r.dir, "uji-*")
	if err != nil {
		finish("failed", "tidak bisa membuat folder kerja: "+err.Error())
		return
	}
	defer os.RemoveAll(dir)
	script, err := writeScript(dir)
	if err != nil {
		finish("failed", "tidak bisa menulis skrip: "+err.Error())
		return
	}
	env, err := k6Env(j)
	if err != nil {
		finish("failed", err.Error())
		return
	}

	for i, st := range j.Stages {
		stageCtx, cancelStage := context.WithCancel(ctx)
		cancelled := make(chan struct{}, 1)
		go func() { // heartbeat; juga cara aplikasi meminta pembatalan di tengah tahap
			t := time.NewTicker(r.beat)
			defer t.Stop()
			for {
				select {
				case <-stageCtx.Done():
					return
				case <-t.C:
					if c, err := r.api.heartbeat(stageCtx, j.ID); err == nil && c {
						cancelled <- struct{}{}
						cancelStage()
						return
					}
				}
			}
		}()

		summary := filepath.Join(dir, fmt.Sprintf("tahap-%d.json", i))
		meter := newCPUMeter(r.cpu)
		meter.start()
		stopScrape := startScrape(stageCtx, j.Scrape, time.Second, r.scrapeHTT)
		started := nowMs()
		out, runErr := r.run(stageCtx, r.k6, k6Args(script, summary, st), env)
		ended := nowMs()
		scraped := stopScrape()
		cpu := meter.stop()
		cancelStage()

		select {
		case <-cancelled:
			finish("cancelled", "dibatalkan oleh pengguna")
			return
		default:
		}
		if ctx.Err() != nil {
			finish("cancelled", "runner dihentikan")
			return
		}
		if runErr != nil {
			finish("failed", fmt.Sprintf("k6 gagal pada tahap %d: %v: %s", i+1, runErr, out))
			return
		}
		stats, err := readSummary(summary)
		if err != nil {
			finish("failed", fmt.Sprintf("tahap %d: %v", i+1, err))
			return
		}
		rep := StageReport{Idx: i, VUs: st.VUs, Seconds: st.Seconds, Started: started, Ended: ended, Reqs: stats.Reqs, RPS: stats.RPS, P50: stats.P50, P95: stats.P95, P99: stats.P99, ErrPct: stats.ErrPct, GenCPU: cpu, Scraped: scraped}
		cancel, err := r.api.stage(ctx, j.ID, rep)
		if err != nil {
			finish("failed", fmt.Sprintf("tahap %d: gagal melapor: %v", i+1, err))
			return
		}
		r.logf("uji %d tahap %d/%d: %d pengguna, %.1f req/dtk, p95 %.0f ms, error %.1f%%, CPU pembangkit %.0f%%", j.ID, i+1, len(j.Stages), st.VUs, stats.RPS, stats.P95, stats.ErrPct, cpu*100)
		if cancel {
			finish("cancelled", "dibatalkan oleh pengguna")
			return
		}
	}
	finish("done", "")
}

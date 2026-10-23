// aiops-loadgen: runner pembangkit beban. Menghubungi aplikasi AI Ops (keluar saja), mengambil uji beban yang SUDAH Anda setujui,
// menjalankannya dengan k6 per tahap, dan melaporkan hasil per tahap. Tidak membuka port, tidak menerima perintah selain pekerjaan itu.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const version = "1.0.0"

func secretFrom(env string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	if f := os.Getenv(env + "_FILE"); f != "" {
		if b, err := os.ReadFile(f); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

func k6Version(bin string) string {
	out, err := exec.Command(bin, "version").Output()
	if err != nil {
		return "tidak diketahui"
	}
	return strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
}

func main() {
	showVersion := flag.Bool("version", false, "cetak versi lalu keluar")
	flag.Parse()
	if *showVersion {
		fmt.Println("aiops-loadgen", version)
		return
	}
	server, k6 := os.Getenv("LOADGEN_SERVER"), os.Getenv("K6_BIN")
	if server == "" {
		server = "http://app:4317"
	}
	if k6 == "" {
		k6 = "k6"
	}
	secret := secretFrom("LOADGEN_SECRET")
	if secret == "" {
		log.Fatal("LOADGEN_SECRET (atau LOADGEN_SECRET_FILE) belum disetel")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	api := newAPI(strings.TrimRight(server, "/"), secret)
	r := newRunner(api, k6)
	r.dir = os.TempDir()
	cpus := r.cpu.cpus()
	if cpus <= 0 {
		cpus = float64(runtime.NumCPU())
	}
	info := RunnerInfo{K6: k6Version(k6), CPUs: cpus, Version: version}
	log.Printf("aiops-loadgen %s | %s | CPU %.1f | server %s", version, info.K6, info.CPUs, server)

	backoff := time.Second
	for ctx.Err() == nil {
		job, err := api.next(ctx, info, 25)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			log.Printf("gagal mengambil pekerjaan: %v (coba lagi %s)", err, backoff)
			select {
			case <-ctx.Done():
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		if job == nil {
			continue
		}
		log.Printf("uji %d dimulai: %s, %d tahap", job.ID, job.Target, len(job.Stages))
		r.runJob(ctx, job)
	}
	log.Print("berhenti")
}

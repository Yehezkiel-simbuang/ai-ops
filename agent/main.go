package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
)

// Diisi saat build: -ldflags "-X main.version=1.0.0"
var version = "dev"

const exampleConfig = `{
  "server_url": "https://aiops.contoh.com",
  "key_id": "ISI_DARI_APLIKASI",
  "secret": "ISI_DARI_APLIKASI_MINIMAL_32_KARAKTER",
  "interval_seconds": 30,
  "heartbeat_seconds": 60,
  "allow_exec": false,
  "thresholds": { "load_per_core_crit": 3, "mem_avail_pct_crit": 5, "disk_pct_crit": 95, "io_psi_crit": 50, "disk_path": "/" },
  "services": ["mysql", "nginx"],
  "ports": [{ "name": "mysql", "port": 3306 }],
  "http": [{ "name": "app", "url": "http://127.0.0.1/", "crit_ms": 8000 }],
  "logs": [{ "name": "php-fpm max_children", "path": "/var/log/php8.2-fpm.log", "pattern": "reached pm.max_children", "crit_delta": 10 }],
  "commands": [{ "name": "failed_jobs", "cmd": "mysql -N app -e 'SELECT COUNT(*) FROM failed_jobs'", "crit": 100 }]
}
`

func main() {
	cfgPath := flag.String("config", "/etc/aiops-agent.json", "berkas konfigurasi")
	showVersion := flag.Bool("version", false, "tampilkan versi")
	check := flag.Bool("check", false, "jalankan semua pemeriksaan sekali, cetak hasilnya, lalu keluar (tanpa mengirim apa pun)")
	example := flag.Bool("example", false, "cetak contoh konfigurasi")
	flag.Parse()
	if *showVersion {
		fmt.Println("aiops-agent", version)
		return
	}
	if *example {
		fmt.Print(exampleConfig)
		return
	}
	logf := log.New(os.Stderr, "aiops-agent: ", log.LstdFlags)
	cfg, err := LoadConfig(*cfgPath)
	if err != nil {
		logf.Fatalf("%v", err)
	}
	if st, err := os.Stat(*cfgPath); err == nil && st.Mode().Perm()&0o077 != 0 {
		logf.Printf("PERINGATAN: %s bisa dibaca pengguna lain (mode %o); jalankan: chmod 600 %s", *cfgPath, st.Mode().Perm(), *cfgPath)
	}
	a := NewAgent(cfg, newSys(), shRunner{}, NewClient(cfg, version), version, logf)
	if *check {
		ctx := context.Background()
		for _, c := range a.checks {
			r := c.Run(ctx)
			state := "normal"
			switch {
			case r.Unknown:
				state = "tidak terbaca"
			case r.Lvl() != LevelOK:
				state = r.Lvl().Label()
			}
			b, _ := json.Marshal(r.Value)
			fmt.Printf("%-28s %-14s nilai=%s %s\n", c.Key, state, b, r.Detail)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	a.Run(ctx)
}

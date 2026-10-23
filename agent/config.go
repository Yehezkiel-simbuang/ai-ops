package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

// Config dibaca dari berkas JSON (mode 0600 disarankan karena berisi rahasia). Hanya ambang KRITIS yang ada:
// agen sengaja tidak punya "peringatan" supaya yang dikirim ke aplikasi hanya hal yang benar-benar genting.
type Config struct {
	ServerURL        string `json:"server_url"`
	KeyID            string `json:"key_id"`
	Secret           string `json:"secret"`
	IntervalSeconds  int    `json:"interval_seconds"`
	HeartbeatSeconds int    `json:"heartbeat_seconds"`
	Confirm          int    `json:"confirm"`        // gagal berturut-turut sebelum dianggap kritis
	Recover          int    `json:"recover"`        // normal berturut-turut sebelum dianggap pulih
	ReannounceMin    int    `json:"reannounce_min"` // kirim ulang "masih kritis" tiap N menit (0 = mati)
	AllowExec        bool   `json:"allow_exec"`     // izinkan menjalankan perintah yang sudah DISETUJUI di aplikasi
	StateDir         string `json:"state_dir"`
	InsecureHTTP     bool   `json:"insecure_http"` // izinkan http:// (hanya untuk uji lokal)
	CAFile           string `json:"ca_file"`       // berkas PEM CA/sertifikat yang dipercaya (mis. CA internal Caddy) selain trust store sistem

	Thresholds Thresholds  `json:"thresholds"`
	Services   []string    `json:"services"`
	Ports      []PortCheck `json:"ports"`
	HTTP       []HTTPCheck `json:"http"`
	Logs       []LogCheck  `json:"logs"`
	Commands   []CmdCheck  `json:"commands"`
}

type Thresholds struct {
	LoadPerCoreCrit float64 `json:"load_per_core_crit"` // load 5 menit / jumlah core
	MemAvailPctCrit float64 `json:"mem_avail_pct_crit"` // kritis bila memori tersedia di bawah ini (%)
	DiskPctCrit     float64 `json:"disk_pct_crit"`      // kritis bila disk root terpakai di atas ini (%)
	IOPsiCrit       float64 `json:"io_psi_crit"`        // PSI io (some, avg10) di atas ini (%)
	DiskPath        string  `json:"disk_path"`
}
type PortCheck struct {
	Name string `json:"name"`
	Port int    `json:"port"`
}
type HTTPCheck struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	CritMs  int    `json:"crit_ms"`
	MinCode int    `json:"min_code"`
	MaxCode int    `json:"max_code"`
}
type LogCheck struct {
	Name      string  `json:"name"`
	Path      string  `json:"path"`
	Pattern   string  `json:"pattern"`
	CritDelta float64 `json:"crit_delta"` // kenaikan jumlah kemunculan antar pemeriksaan
}
type CmdCheck struct {
	Name string  `json:"name"`
	Cmd  string  `json:"cmd"`
	Crit float64 `json:"crit"`
	Dir  string  `json:"dir"` // "gt" (bawaan) atau "lt"
}

func DefaultConfig() Config {
	return Config{
		IntervalSeconds: 30, HeartbeatSeconds: 60, Confirm: 2, Recover: 2, ReannounceMin: 60, StateDir: "/var/lib/aiops-agent",
		Thresholds: Thresholds{LoadPerCoreCrit: 3, MemAvailPctCrit: 5, DiskPctCrit: 95, IOPsiCrit: 50, DiskPath: "/"},
	}
}

func LoadConfig(path string) (Config, error) {
	c := DefaultConfig()
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("config tidak valid: %w", err)
	}
	for _, kv := range [][2]string{{"AIOPS_SERVER_URL", "server_url"}, {"AIOPS_KEY_ID", "key_id"}, {"AIOPS_SECRET", "secret"}} {
		if v := os.Getenv(kv[0]); v != "" {
			switch kv[1] {
			case "server_url":
				c.ServerURL = v
			case "key_id":
				c.KeyID = v
			case "secret":
				c.Secret = v
			}
		}
	}
	return c, c.Validate()
}

func (c *Config) Validate() error {
	c.ServerURL = strings.TrimRight(c.ServerURL, "/")
	switch {
	case c.ServerURL == "":
		return errors.New("server_url wajib")
	case !strings.HasPrefix(c.ServerURL, "https://") && !(c.InsecureHTTP && strings.HasPrefix(c.ServerURL, "http://")):
		return errors.New("server_url harus https:// (http:// hanya bila insecure_http=true, untuk uji lokal)")
	case c.KeyID == "" || len(c.Secret) < 32:
		return errors.New("key_id dan secret (min. 32 karakter) wajib")
	case c.IntervalSeconds < 5 || c.IntervalSeconds > 3600:
		return errors.New("interval_seconds 5..3600")
	case c.HeartbeatSeconds < 15 || c.HeartbeatSeconds > 3600:
		return errors.New("heartbeat_seconds 15..3600")
	case c.Confirm < 1 || c.Confirm > 20 || c.Recover < 1 || c.Recover > 20:
		return errors.New("confirm dan recover 1..20")
	}
	if c.CAFile != "" {
		if _, err := loadCAPool(c.CAFile); err != nil {
			return err
		}
	}
	for _, p := range c.Ports {
		if p.Port < 1 || p.Port > 65535 || p.Name == "" {
			return errors.New("port check tidak valid")
		}
	}
	for _, l := range c.Logs {
		if l.Path == "" || l.Pattern == "" || l.Name == "" {
			return errors.New("log check butuh name, path, pattern")
		}
	}
	return nil
}

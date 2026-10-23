package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Tingkat keparahan: critical (tindak sekarang), major (tindak hari ini), minor (lihat kalau sempat), info (hanya jejak).
type Level int

const (
	LevelOK Level = iota
	LevelInfo
	LevelMinor
	LevelMajor
	LevelCritical
)

func (l Level) String() string {
	switch l {
	case LevelInfo:
		return "info"
	case LevelMinor:
		return "minor"
	case LevelMajor:
		return "major"
	case LevelCritical:
		return "critical"
	}
	return ""
}

// Label dipakai di keluaran -check (huruf besar, istilah Inggris seperti di aplikasi).
func (l Level) Label() string { return strings.ToUpper(l.String()) }

// ParseLevel membaca nama tingkat; nilai kosong atau asing memakai def.
func ParseLevel(s string, def Level) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "info":
		return LevelInfo
	case "minor":
		return LevelMinor
	case "major":
		return LevelMajor
	case "critical", "crit", "kritis":
		return LevelCritical
	}
	return def
}

// Limit adalah batas tiga tingkat untuk satu nilai angka. Batas yang nil tidak dipakai.
type Limit struct {
	Minor    *float64 `json:"minor,omitempty"`
	Major    *float64 `json:"major,omitempty"`
	Critical *float64 `json:"critical,omitempty"`
}

func ptr(v float64) *float64 { return &v }

// optLimit membuat Limit dari angka konfigurasi lokal (0 = tidak dipakai).
func optLimit(minor, major, crit float64) Limit {
	var l Limit
	if minor > 0 {
		l.Minor = ptr(minor)
	}
	if major > 0 {
		l.Major = ptr(major)
	}
	if crit > 0 {
		l.Critical = ptr(crit)
	}
	return l
}

func cross(v float64, th *float64, dir string) bool {
	if th == nil {
		return false
	}
	if dir == "lt" {
		return v <= *th
	}
	return v >= *th
}

// Eval menilai v: tingkat tertinggi yang batasnya terlewati, dan batas itu. dir "gt" = bahaya bila naik, "lt" = bila turun.
func (l Limit) Eval(v float64, dir string) (Level, float64) {
	switch {
	case cross(v, l.Critical, dir):
		return LevelCritical, *l.Critical
	case cross(v, l.Major, dir):
		return LevelMajor, *l.Major
	case cross(v, l.Minor, dir):
		return LevelMinor, *l.Minor
	}
	return LevelOK, 0
}

// ---------- konfigurasi dari aplikasi (halaman Standar): batas dan tingkat kejadian untuk semua server

// RemoteConfig diambil dari /agent/v1/config. Bila ada, ia menggantikan batas lokal; bila tidak, batas lokal dipakai.
type RemoteConfig struct {
	Version string            `json:"version"`
	Limits  map[string]Limit  `json:"limits"`
	Events  map[string]string `json:"events"`
}

// Tuning menyimpan konfigurasi dari aplikasi dengan aman untuk dipakai banyak goroutine. Metodenya aman dipanggil pada nilai nil.
type Tuning struct {
	mu   sync.RWMutex
	rc   RemoteConfig
	path string
}

func NewTuning(stateDir string) *Tuning {
	t := &Tuning{}
	if stateDir != "" {
		t.path = filepath.Join(stateDir, "remote-config.json")
		if b, err := os.ReadFile(t.path); err == nil {
			_ = json.Unmarshal(b, &t.rc) // salinan terakhir yang diterima: dipakai bila aplikasi belum terjangkau saat agen dimulai
		}
	}
	return t
}

func (t *Tuning) Version() string {
	if t == nil {
		return ""
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.rc.Version
}

func (t *Tuning) Set(rc RemoteConfig) {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.rc = rc
	t.mu.Unlock()
	if t.path != "" {
		if err := os.MkdirAll(filepath.Dir(t.path), 0o700); err == nil {
			b, _ := json.Marshal(rc)
			tmp := t.path + ".tmp"
			if os.WriteFile(tmp, b, 0o600) == nil {
				_ = os.Rename(tmp, t.path)
			}
		}
	}
}

// Limit mengembalikan batas dari aplikasi untuk key bila ada, jika tidak batas lokal.
func (t *Tuning) Limit(key string, local Limit) Limit {
	if t == nil {
		return local
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	if l, ok := t.rc.Limits[key]; ok {
		return l
	}
	return local
}

// Event mengembalikan tingkat kejadian dari aplikasi untuk key bila ada, jika tidak def.
func (t *Tuning) Event(key string, def Level) Level {
	if t == nil {
		return def
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	if s, ok := t.rc.Events[key]; ok {
		return ParseLevel(s, def)
	}
	return def
}

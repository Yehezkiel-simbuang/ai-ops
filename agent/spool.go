package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Spool menyimpan kejadian yang belum terkirim di disk supaya tidak hilang saat aplikasi tidak terjangkau atau agen restart.
type Spool struct {
	mu    sync.Mutex
	path  string
	max   int
	Items []Event
}

func LoadSpool(path string, max int) *Spool {
	s := &Spool{path: path, max: max}
	if path == "" {
		return s
	}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &s.Items)
	}
	return s
}

func (s *Spool) Add(e Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Items = append(s.Items, e)
	if len(s.Items) > s.max { // buang yang terlama; kejadian terbaru lebih berarti
		s.Items = s.Items[len(s.Items)-s.max:]
	}
	s.saveLocked()
}

func (s *Spool) Peek(n int) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n > len(s.Items) {
		n = len(s.Items)
	}
	return append([]Event(nil), s.Items[:n]...)
}

func (s *Spool) Len() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.Items) }

func (s *Spool) RemoveFirst(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n > len(s.Items) {
		n = len(s.Items)
	}
	s.Items = append([]Event(nil), s.Items[n:]...)
	s.saveLocked()
}

func (s *Spool) saveLocked() {
	if s.path == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(s.path), 0o700)
	b, _ := json.Marshal(s.Items)
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

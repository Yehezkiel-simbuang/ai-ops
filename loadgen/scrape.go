package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Membaca metrik server uji selama tahap berjalan (tiap detik), supaya hasil uji menunjukkan komponen mana yang naik saat beban naik.
// Format: teks Prometheus (node_exporter, postgres_exporter, redis_exporter, cAdvisor, dst.) atau JSON dengan jalur kunci "a.b.c".

func readMetric(body []byte, metric string) (float64, bool) {
	b := bytes.TrimSpace(body)
	if len(b) > 0 && (b[0] == '{' || b[0] == '[') {
		var doc any
		if json.Unmarshal(b, &doc) != nil {
			return 0, false
		}
		cur := doc
		for _, k := range strings.Split(metric, ".") {
			m, ok := cur.(map[string]any)
			if !ok {
				return 0, false
			}
			if cur, ok = m[k]; !ok {
				return 0, false
			}
		}
		switch v := cur.(type) {
		case float64:
			return v, true
		case bool:
			if v {
				return 1, true
			}
			return 0, true
		}
		return 0, false
	}
	// teks Prometheus: jumlahkan semua deret dengan nama persis itu (mis. per-core -> total)
	var sum float64
	found := false
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' || !strings.HasPrefix(line, metric) {
			continue
		}
		rest := line[len(metric):]
		if rest == "" || (rest[0] != ' ' && rest[0] != '{' && rest[0] != '\t') {
			continue // nama lain yang berawalan sama (mis. metric_total)
		}
		if rest[0] == '{' {
			end := strings.LastIndex(rest, "}")
			if end < 0 {
				continue
			}
			rest = rest[end+1:]
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		if v, err := strconv.ParseFloat(f[0], 64); err == nil {
			sum += v
			found = true
		}
	}
	return sum, found
}

type sampler struct {
	mu    sync.Mutex
	stats map[string]*acc
}

type acc struct {
	sum, max, last float64
	n              int
}

func (s *sampler) add(label string, v float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.stats[label]
	if a == nil {
		a = &acc{max: v}
		s.stats[label] = a
	}
	a.sum += v
	a.n++
	a.last = v
	if v > a.max {
		a.max = v
	}
}

func (s *sampler) result() map[string]Sampled {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]Sampled{}
	for k, a := range s.stats {
		if a.n > 0 {
			out[k] = Sampled{Avg: a.sum / float64(a.n), Max: a.max, Last: a.last}
		}
	}
	return out
}

// startScrape membaca semua metrik tiap `every` sampai ctx selesai; panggil stop() untuk mendapat ringkasan.
func startScrape(ctx context.Context, items []Scrape, every time.Duration, client *http.Client) (stop func() map[string]Sampled) {
	s := &sampler{stats: map[string]*acc{}}
	done := make(chan struct{})
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		defer close(done)
		if len(items) == 0 {
			<-ctx.Done()
			return
		}
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			for _, it := range items {
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, it.URL, nil)
				if err != nil {
					continue
				}
				resp, err := client.Do(req)
				if err != nil {
					continue
				}
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
				resp.Body.Close()
				if v, ok := readMetric(body, it.Metric); ok {
					s.add(it.Label, v)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	return func() map[string]Sampled { cancel(); <-done; return s.result() }
}

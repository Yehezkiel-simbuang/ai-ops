package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Hasil ringkasan k6 (--summary-export). Format lama menaruh nilai langsung di bawah nama metrik, format baru di bawah "values":
// keduanya dibaca.

type k6Metric map[string]any

func (m k6Metric) num(keys ...string) float64 {
	src := map[string]any(m)
	if v, ok := m["values"].(map[string]any); ok {
		src = v
	}
	for _, k := range keys {
		if f, ok := src[k].(float64); ok {
			return f
		}
	}
	return 0
}

type StageStats struct{ Reqs, RPS, P50, P95, P99, ErrPct float64 }

func parseSummary(raw []byte) (StageStats, error) {
	var doc struct {
		Metrics map[string]k6Metric `json:"metrics"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return StageStats{}, fmt.Errorf("ringkasan k6 tidak terbaca: %w", err)
	}
	d, ok := doc.Metrics["http_req_duration"]
	if !ok {
		return StageStats{}, fmt.Errorf("ringkasan k6 tidak memuat http_req_duration (tidak ada request yang selesai?)")
	}
	reqs := doc.Metrics["http_reqs"]
	failed := doc.Metrics["http_req_failed"]
	// http_req_failed adalah Rate: "value" (format lama) atau "rate"; 0..1
	return StageStats{
		Reqs: reqs.num("count"), RPS: reqs.num("rate"),
		P50: d.num("med", "p(50)"), P95: d.num("p(95)"), P99: d.num("p(99)", "max"),
		ErrPct: failed.num("value", "rate") * 100,
	}, nil
}

func readSummary(path string) (StageStats, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return StageStats{}, err
	}
	return parseSummary(raw)
}

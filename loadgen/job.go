package main

// Bentuk pekerjaan dari aplikasi dan laporan tahap ke aplikasi (JSON; sama dengan server/src/loadtest/schema.ts).

type Request struct {
	Name   string `json:"name"`
	Method string `json:"method"`
	Path   string `json:"path"`
	Weight int    `json:"weight"`
	Body   string `json:"body,omitempty"`
}

type Stage struct {
	VUs     int `json:"vus"`
	Seconds int `json:"seconds"`
}

type Scrape struct {
	Label  string `json:"label"`
	URL    string `json:"url"`
	Metric string `json:"metric"`
}

type Job struct {
	ID           int               `json:"id"`
	Target       string            `json:"target"`
	AllowPublic  bool              `json:"allowPublic"`
	Requests     []Request         `json:"requests"`
	ThinkSeconds float64           `json:"thinkSeconds"`
	Headers      map[string]string `json:"headers"`
	Stages       []Stage           `json:"stages"`
	Scrape       []Scrape          `json:"scrape"`
}

type Sampled struct {
	Avg  float64 `json:"avg"`
	Max  float64 `json:"max"`
	Last float64 `json:"last"`
}

type StageReport struct {
	Idx     int                `json:"idx"`
	VUs     int                `json:"vus"`
	Seconds int                `json:"seconds"`
	Started float64            `json:"started"`
	Ended   float64            `json:"ended"`
	Reqs    float64            `json:"reqs"`
	RPS     float64            `json:"rps"`
	P50     float64            `json:"p50"`
	P95     float64            `json:"p95"`
	P99     float64            `json:"p99"`
	ErrPct  float64            `json:"errPct"`
	GenCPU  float64            `json:"genCpu"`
	Scraped map[string]Sampled `json:"scraped"`
}

type RunnerInfo struct {
	K6      string  `json:"k6"`
	CPUs    float64 `json:"cpus"`
	Version string  `json:"version"`
}

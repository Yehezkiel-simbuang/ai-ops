package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Pemakaian CPU pembangkit beban sendiri (0..1 dari kuota kontainer). Bila di atas ~0,7, yang jenuh mungkin pembangkitnya
// dan bukan server uji, jadi aplikasi menandai hasil tahap itu tidak murni.

type cpuReader interface {
	usageSeconds() (float64, bool) // total CPU yang dipakai kontainer sejak mulai
	cpus() float64                 // kuota CPU (jumlah core efektif)
}

type cgroupCPU struct{ root string }

func (c cgroupCPU) read(name string) string {
	b, err := os.ReadFile(c.root + "/" + name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (c cgroupCPU) usageSeconds() (float64, bool) {
	// cgroup v2: cpu.stat "usage_usec N"
	for _, line := range strings.Split(c.read("cpu.stat"), "\n") {
		if f := strings.Fields(line); len(f) == 2 && f[0] == "usage_usec" {
			if v, err := strconv.ParseFloat(f[1], 64); err == nil {
				return v / 1e6, true
			}
		}
	}
	// cgroup v1: cpuacct.usage (nanodetik)
	if v, err := strconv.ParseFloat(c.read("cpuacct/cpuacct.usage"), 64); err == nil {
		return v / 1e9, true
	}
	return 0, false
}

func (c cgroupCPU) cpus() float64 {
	// v2: cpu.max "max 100000" atau "150000 100000"
	if f := strings.Fields(c.read("cpu.max")); len(f) == 2 && f[0] != "max" {
		q, e1 := strconv.ParseFloat(f[0], 64)
		p, e2 := strconv.ParseFloat(f[1], 64)
		if e1 == nil && e2 == nil && p > 0 {
			return q / p
		}
	}
	// v1: cpu.cfs_quota_us / cpu.cfs_period_us
	q, e1 := strconv.ParseFloat(c.read("cpu/cpu.cfs_quota_us"), 64)
	p, e2 := strconv.ParseFloat(c.read("cpu/cpu.cfs_period_us"), 64)
	if e1 == nil && e2 == nil && q > 0 && p > 0 {
		return q / p
	}
	return float64(runtime.NumCPU())
}

// cpuMeter mengukur rata-rata pemakaian di antara start() dan stop().
type cpuMeter struct {
	r     cpuReader
	now   func() time.Time
	t0    time.Time
	use0  float64
	have0 bool
}

func newCPUMeter(r cpuReader) *cpuMeter { return &cpuMeter{r: r, now: time.Now} }

func (m *cpuMeter) start() { m.t0 = m.now(); m.use0, m.have0 = m.r.usageSeconds() }

// stop mengembalikan pemakaian 0..1 (relatif terhadap kuota); 0 bila tidak bisa diukur.
func (m *cpuMeter) stop() float64 {
	use1, ok := m.r.usageSeconds()
	wall := m.now().Sub(m.t0).Seconds()
	cpus := m.r.cpus()
	if !m.have0 || !ok || wall <= 0 || cpus <= 0 {
		return 0
	}
	u := (use1 - m.use0) / (wall * cpus)
	if u < 0 {
		return 0
	}
	if u > 1 {
		return 1
	}
	return u
}

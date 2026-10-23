package main

import (
	"bufio"
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// Sys adalah sumber metrik sistem. Antarmuka supaya logika pemeriksaan bisa diuji tanpa Linux sungguhan.
type Sys interface {
	Cores() int
	Load5() (float64, error)
	MemAvailPct() (float64, error)
	DiskPct(path string) (float64, error)
	IOPsi() (float64, bool, error) // false bila kernel tidak menyediakan PSI
	UptimeSeconds() (int64, error)
}

type procSys struct{ root string } // root "" = /proc sungguhan; bisa diarahkan ke folder uji

func (p procSys) path(n string) string { return p.root + "/proc/" + n }
func (procSys) Cores() int             { return runtime.NumCPU() }

func (p procSys) Load5() (float64, error) {
	b, err := os.ReadFile(p.path("loadavg"))
	if err != nil {
		return 0, err
	}
	f := strings.Fields(string(b))
	if len(f) < 2 {
		return 0, errors.New("format loadavg tidak dikenal")
	}
	return strconv.ParseFloat(f[1], 64)
}

func (p procSys) MemAvailPct() (float64, error) {
	f, err := os.Open(p.path("meminfo"))
	if err != nil {
		return 0, err
	}
	defer f.Close()
	var total, avail float64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		parts := strings.Fields(sc.Text())
		if len(parts) < 2 {
			continue
		}
		v, _ := strconv.ParseFloat(parts[1], 64)
		switch parts[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			avail = v
		}
	}
	if total <= 0 {
		return 0, errors.New("MemTotal tidak ditemukan")
	}
	return 100 * avail / total, nil
}

func (p procSys) IOPsi() (float64, bool, error) {
	b, err := os.ReadFile(p.path("pressure/io"))
	if err != nil {
		return 0, false, nil // tanpa PSI: bukan galat
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "some ") {
			continue
		}
		for _, kv := range strings.Fields(line) {
			if strings.HasPrefix(kv, "avg10=") {
				v, err := strconv.ParseFloat(strings.TrimPrefix(kv, "avg10="), 64)
				return v, true, err
			}
		}
	}
	return 0, false, nil
}

func (p procSys) UptimeSeconds() (int64, error) {
	b, err := os.ReadFile(p.path("uptime"))
	if err != nil {
		return 0, err
	}
	f := strings.Fields(string(b))
	if len(f) < 1 {
		return 0, errors.New("format uptime tidak dikenal")
	}
	v, err := strconv.ParseFloat(f[0], 64)
	return int64(v), err
}

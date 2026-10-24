package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// PatchInfo adalah fakta pembaruan sistem. Agen hanya MELAPORKAN fakta; tingkat keparahannya dinilai aplikasi menurut halaman Standar.
// Pointer nil = tidak diketahui (mis. manajer paket tidak dikenal), supaya tidak dibaca sebagai "0 pembaruan".
type PatchInfo struct {
	Manager     string `json:"manager,omitempty"`
	Updates     *int   `json:"updates,omitempty"`
	Security    *int   `json:"security,omitempty"`
	Reboot      bool   `json:"reboot"`
	RebootSince int64  `json:"reboot_since,omitempty"` // detik epoch berkas penanda reboot dibuat
	OSID        string `json:"os_id,omitempty"`
	OSVersion   string `json:"os_version,omitempty"`
	OSName      string `json:"os_name,omitempty"`
	Kernel      string `json:"kernel,omitempty"`
}

// Hanya membaca. apt-get -s (simulasi) dan dnf tidak mengubah apa pun; apt memakai daftar paket yang sudah ada (tanpa mengunduh).
const patchScript = `. /etc/os-release 2>/dev/null
echo "os_id=$ID"; echo "os_version=$VERSION_ID"; echo "os_name=$PRETTY_NAME"; echo "kernel=$(uname -r)"
if command -v apt-get >/dev/null 2>&1; then
  echo "manager=apt"; L=$(apt-get -s upgrade 2>/dev/null | grep '^Inst ')
  echo "updates=$(printf '%s' "$L" | grep -c .)"; echo "security=$(printf '%s' "$L" | grep -ci security)"
elif command -v dnf >/dev/null 2>&1; then
  echo "manager=dnf"; echo "updates=$(dnf -q check-update 2>/dev/null | grep -cE '^[A-Za-z0-9_.+-]+\.[A-Za-z0-9_]+ +[0-9]')"
  echo "security=$(dnf -q updateinfo list security 2>/dev/null | grep -c .)"
fi
if [ -f /var/run/reboot-required ]; then echo "reboot=1"; echo "reboot_since=$(stat -c %Y /var/run/reboot-required 2>/dev/null)"
elif command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; then echo "reboot=1"; echo "reboot_since=$(date +%s)"
else echo "reboot=0"; fi`

// CollectPatch menjalankan skrip baca-saja dan menguraikan keluarannya (baris key=value).
func CollectPatch(ctx context.Context, run Runner) (PatchInfo, error) {
	out, _, err := run.Run(ctx, patchScript, 90*time.Second)
	if err != nil && out == "" {
		return PatchInfo{}, err
	}
	return parsePatch(out), nil
}

func parsePatch(out string) PatchInfo {
	var p PatchInfo
	num := func(v string) *int {
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 0 {
			return nil
		}
		return &n
	}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "os_id":
			p.OSID = clipStr(v, 40)
		case "os_version":
			p.OSVersion = clipStr(v, 40)
		case "os_name":
			p.OSName = clipStr(v, 100)
		case "kernel":
			p.Kernel = clipStr(v, 80)
		case "manager":
			p.Manager = clipStr(v, 20)
		case "updates":
			p.Updates = num(v)
		case "security":
			p.Security = num(v)
		case "reboot":
			p.Reboot = v == "1"
		case "reboot_since":
			if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
				p.RebootSince = n
			}
		}
	}
	if p.Updates == nil { // tanpa jumlah pembaruan, angka keamanan tidak berarti
		p.Security = nil
	}
	return p
}

// ReportPatch mengumpulkan fakta pembaruan dan mengirimnya sekali. Gagal tidak mengganggu pemantauan lain; dicoba lagi pada putaran berikutnya.
func (a *Agent) ReportPatch(ctx context.Context) error {
	p, err := CollectPatch(ctx, a.run)
	if err != nil {
		return fmt.Errorf("fakta pembaruan: %w", err)
	}
	body, _ := json.Marshal(p)
	code, _, err := a.client.Do(ctx, "POST", "/agent/v1/patch", body)
	if err != nil {
		return err
	}
	if code != 200 {
		return fmt.Errorf("patch HTTP %d", code)
	}
	return nil
}

// patchLoop melapor sekali saat mulai, lalu tiap patchEvery. Berjalan di goroutine sendiri agar pemeriksaan dan detak jantung tidak tertahan.
func (a *Agent) patchLoop(ctx context.Context) {
	t := time.NewTicker(patchEvery)
	defer t.Stop()
	for {
		if err := a.ReportPatch(ctx); err != nil {
			a.logf.Printf("pembaruan: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// patchEvery: seberapa sering fakta pembaruan dilaporkan. Fakta ini berubah lambat; bisa diganti saat uji.
var patchEvery = 6 * time.Hour

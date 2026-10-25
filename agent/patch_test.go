package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

const aptOut = "os_id=ubuntu\nos_version=22.04\nos_name=Ubuntu 22.04.4 LTS\nkernel=5.15.0-101-generic\nmanager=apt\nupdates=23\nsecurity=4\nreboot=1\nreboot_since=1700000000\n"

func TestParsePatchApt(t *testing.T) {
	p := parsePatch(aptOut)
	if p.OSID != "ubuntu" || p.OSVersion != "22.04" || p.Manager != "apt" || p.Kernel != "5.15.0-101-generic" {
		t.Fatalf("identitas: %+v", p)
	}
	if p.Updates == nil || *p.Updates != 23 || p.Security == nil || *p.Security != 4 {
		t.Fatalf("jumlah: %+v", p)
	}
	if !p.Reboot || p.RebootSince != 1700000000 {
		t.Fatalf("reboot: %+v", p)
	}
}

func TestParsePatchUnknownManagerLeavesCountsNil(t *testing.T) {
	p := parsePatch("os_id=alpine\nos_version=3.19\nreboot=0\nsecurity=5\n")
	if p.Updates != nil || p.Security != nil {
		t.Fatalf("tanpa manajer paket dikenal, jumlah harus tidak diketahui (bukan 0): %+v", p)
	}
	if p.Reboot {
		t.Fatal("reboot=0 tidak boleh dibaca sebagai perlu reboot")
	}
	if got := parsePatch("updates=abc\nupdates=-3\n").Updates; got != nil {
		t.Fatalf("angka rusak harus diabaikan: %v", *got)
	}
}

func TestReportPatchSendsFacts(t *testing.T) {
	app := newFakeApp(t)
	a := newTestAgent(t, app, nil, &fakeSys{cores: 2, load: 0.1, mem: 50, disk: 10}, &fakeRun{outs: map[string]string{"os-release": aptOut}})
	if err := a.ReportPatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	app.mu.Lock()
	defer app.mu.Unlock()
	if len(app.patches) != 1 {
		t.Fatalf("satu laporan: %d", len(app.patches))
	}
	var got PatchInfo
	if err := json.Unmarshal([]byte(app.patches[0]), &got); err != nil || got.Updates == nil || *got.Updates != 23 || got.OSID != "ubuntu" {
		t.Fatalf("badan: %s (%v)", app.patches[0], err)
	}
}

func TestReportPatchFailureIsReported(t *testing.T) {
	app := newFakeApp(t)
	a := newTestAgent(t, app, nil, &fakeSys{cores: 2, load: 0.1, mem: 50, disk: 10}, &fakeRun{})
	if err := a.ReportPatch(context.Background()); err == nil {
		t.Fatal("skrip yang gagal tanpa keluaran harus menjadi galat, bukan laporan kosong")
	}
	app.mu.Lock()
	defer app.mu.Unlock()
	if len(app.patches) != 0 {
		t.Fatal("tidak boleh mengirim laporan kosong")
	}
}

func TestParsePatchPackagesWithSource(t *testing.T) {
	out := "manager=apt\nupdates=2\nsecurity=1\n" +
		"pkg=liblzma5|5.6.1-3|5.6.1-4|Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64]\n" +
		"pkg=curl|8.5.0-1|8.5.0-2|Ubuntu:24.04/noble-updates [amd64]\n" +
		"pkg=rusak-tanpa-bagian\n" +
		"src=liblzma5|xz-utils\nsrc=curl|curl\n"
	p := parsePatch(out)
	if len(p.Packages) != 2 {
		t.Fatalf("baris rusak harus dilewati: %+v", p.Packages)
	}
	a, b := p.Packages[0], p.Packages[1]
	if a.Name != "liblzma5" || a.Source != "xz-utils" || a.Old != "5.6.1-3" || a.New != "5.6.1-4" || !a.Sec {
		t.Fatalf("paket keamanan: %+v", a)
	}
	if b.Name != "curl" || b.Sec {
		t.Fatalf("paket biasa tidak boleh ditandai keamanan: %+v", b)
	}
}

func TestParsePatchPackagesMarkThirdPartyOrigins(t *testing.T) {
	out := strings.Join([]string{
		"pkg=curl|1|2|Ubuntu:24.04/noble-updates [amd64]",
		"pkg=openssl|1|2|Debian:12.5/stable-security [amd64]",
		"pkg=docker-ce|1|2|Docker:noble/stable [amd64]",
		"pkg=mysql-server|1|2|MySQL:noble/mysql-8.0, Ubuntu:24.04/noble-updates [amd64]",
	}, "\n")
	got := map[string]bool{}
	for _, p := range parsePatch(out).Packages {
		got[p.Name] = p.Official
	}
	want := map[string]bool{"curl": true, "openssl": true, "docker-ce": false, "mysql-server": false}
	for n, w := range want {
		if got[n] != w {
			t.Errorf("%s: official=%v, harusnya %v (asal pertama yang menentukan)", n, got[n], w)
		}
	}
}

func TestParsePatchPackagesAreCapped(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < maxPatchPkgs+50; i++ {
		fmt.Fprintf(&sb, "pkg=p%d|1|2|x\n", i)
	}
	if n := len(parsePatch(sb.String()).Packages); n != maxPatchPkgs {
		t.Fatalf("batas %d, dapat %d", maxPatchPkgs, n)
	}
}

func TestHeartbeatPatchFlagTriggersReport(t *testing.T) {
	app := newFakeApp(t)
	a := newTestAgent(t, app, nil, &fakeSys{cores: 2, load: 0.1, mem: 50, disk: 10}, &fakeRun{outs: map[string]string{"os-release": aptOut}})
	if err := a.Heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	app.mu.Lock()
	n := len(app.patches)
	app.patchNow = true
	app.mu.Unlock()
	if n != 0 {
		t.Fatalf("tanpa permintaan, detak jantung tidak boleh memicu laporan: %d", n)
	}
	if err := a.Heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		app.mu.Lock()
		n = len(app.patches)
		app.mu.Unlock()
		if n == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("permintaan lapor ulang dari aplikasi harus menghasilkan satu laporan, dapat %d", n)
}

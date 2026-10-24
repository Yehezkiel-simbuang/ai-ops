package main

import (
	"context"
	"encoding/json"
	"testing"
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

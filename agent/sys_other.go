//go:build !linux

package main

import "errors"

// Agen hanya berjalan di Linux. Berkas ini ada agar kode bisa dikompilasi dan logika murninya diuji di mesin pengembangan lain.
func (procSys) DiskPct(string) (float64, error) { return 0, errors.New("hanya Linux") }
func newSys() Sys                               { return procSys{} }

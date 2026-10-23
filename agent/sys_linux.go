//go:build linux

package main

import (
	"errors"
	"syscall"
)

func (procSys) DiskPct(path string) (float64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	total := float64(st.Blocks) * float64(st.Bsize)
	if total <= 0 {
		return 0, errors.New("ukuran disk 0")
	}
	avail := float64(st.Bavail) * float64(st.Bsize)
	free := float64(st.Bfree) * float64(st.Bsize)
	used := total - free
	// sama dengan df: terpakai / (terpakai + tersedia untuk non-root)
	return 100 * used / (used + avail), nil
}

func newSys() Sys { return procSys{} }

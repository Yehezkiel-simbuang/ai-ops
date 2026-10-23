//go:build !linux

package main

import "os/exec"

func setProcGroup(*exec.Cmd) {}
func killGroup(c *exec.Cmd) {
	if c.Process != nil {
		_ = c.Process.Kill()
	}
}

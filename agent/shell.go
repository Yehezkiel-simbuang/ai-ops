package main

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"time"
)

// execShell menjalankan `sh -c` dengan batas waktu; seluruh grup proses dimatikan saat waktu habis.
func execShell(ctx context.Context, command string, timeout time.Duration, maxOut int) (stdout, stderr string, exit int, timedOut bool) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.Command("sh", "-c", command)
	setProcGroup(cmd)
	var so, se limitedBuf
	so.max, se.max = maxOut, maxOut
	cmd.Stdout, cmd.Stderr = &so, &se
	if err := cmd.Start(); err != nil {
		return "", err.Error(), 127, false
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return so.String(), se.String(), exitCode(err), false
	case <-cctx.Done():
		killGroup(cmd)
		<-done
		return so.String(), se.String() + "\n[waktu habis]", 124, errors.Is(cctx.Err(), context.DeadlineExceeded)
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return 1
}

// limitedBuf menyimpan paling banyak max byte pertama dan menandai bila ada yang dibuang (mencegah memori membengkak).
type limitedBuf struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (l *limitedBuf) Write(p []byte) (int, error) {
	room := l.max - l.buf.Len()
	if room > 0 {
		if len(p) <= room {
			l.buf.Write(p)
		} else {
			l.buf.Write(p[:room])
			l.truncated = true
		}
	} else {
		l.truncated = true
	}
	return len(p), nil
}
func (l *limitedBuf) String() string {
	if l.truncated {
		return l.buf.String() + "\n...[dipotong]"
	}
	return l.buf.String()
}

type shRunner struct{}

func (shRunner) Run(ctx context.Context, cmd string, timeout time.Duration) (string, int, error) {
	so, se, code, to := execShell(ctx, cmd, timeout, 64<<10)
	if to {
		return so, code, errors.New("waktu habis")
	}
	if code != 0 && so == "" {
		return so, code, errors.New(trimErr(errors.New(se)))
	}
	return so, code, nil
}

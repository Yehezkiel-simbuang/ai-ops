package main

import (
	"context"
	"regexp"
	"strings"
	"time"
)

// Diagnostik hanya dikumpulkan SAAT sebuah kondisi menjadi kritis (bukan terus-menerus), dibatasi ukuran, dan disamarkan.
type DiagOut struct {
	Name string `json:"name"`
	Out  string `json:"out"`
}

const (
	diagPerCmd = 2000
	diagTotal  = 8000
)

var secretRe = regexp.MustCompile(`(?i)([A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|credential)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)`)
var bearerRe = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}`)

// Redact menyamarkan pola rahasia umum sebelum teks dikirim keluar dari server.
func Redact(s string) string {
	s = bearerRe.ReplaceAllString(s, "Bearer ***")
	return secretRe.ReplaceAllString(s, "$1=***")
}

func CollectDiag(ctx context.Context, run Runner, specs []DiagSpec) []DiagOut {
	var out []DiagOut
	total := 0
	for _, sp := range specs {
		if total >= diagTotal {
			break
		}
		o, _, err := run.Run(ctx, "( "+sp.Cmd+" ) 2>&1", 5*time.Second)
		if err != nil && strings.TrimSpace(o) == "" {
			o = "(gagal: " + trimErr(err) + ")"
		}
		o = Redact(strings.TrimSpace(o))
		if len(o) > diagPerCmd {
			o = o[:diagPerCmd] + "\n...[dipotong]"
		}
		if total+len(o) > diagTotal {
			o = o[:diagTotal-total]
		}
		if o == "" {
			continue
		}
		total += len(o)
		out = append(out, DiagOut{Name: sp.Name, Out: o})
	}
	return out
}

package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Setiap permintaan ke aplikasi ditandatangani HMAC-SHA256 dengan secret (secret tidak pernah dikirim):
//   sig = HMAC(secret, ts \n METHOD \n path \n sha256(body))
// Aplikasi menolak tanda tangan salah dan cap waktu di luar +-5 menit (cegah replay).

func bodyHash(body []byte) string { h := sha256.Sum256(body); return hex.EncodeToString(h[:]) }

func Sign(secret, ts, method, path string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(m, "%s\n%s\n%s\n%s", ts, method, path, bodyHash(body))
	return hex.EncodeToString(m.Sum(nil))
}

// CommandSig menandatangani perintah yang diizinkan pengguna di aplikasi; agen memverifikasinya sebelum menjalankan.
func CommandSig(secret, id string, expires int64, timeoutS int, command string) string {
	m := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(m, "cmd\n%s\n%d\n%d\n%s", id, expires, timeoutS, command)
	return hex.EncodeToString(m.Sum(nil))
}

func VerifyCommandSig(secret string, c Command) bool {
	want := CommandSig(secret, c.ID, c.Expires, c.TimeoutS, c.Command)
	return hmac.Equal([]byte(want), []byte(c.Sig))
}

type Client struct {
	Base, KeyID, Secret, Version string
	HTTP                         *http.Client
	SentBytes                    atomic.Int64 // total byte badan permintaan yang dikirim (untuk memantau volume)
	Now                          func() time.Time
}

// loadCAPool: trust store sistem + CA tambahan dari berkas (untuk CA internal/jaringan lokal tanpa memasang di sistem).
func loadCAPool(path string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("ca_file tidak bisa dibaca: %w", err)
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("ca_file %s tidak berisi sertifikat PEM yang valid", path)
	}
	return pool, nil
}

func NewClient(cfg Config, version string) *Client {
	tr := &http.Transport{MaxIdleConns: 2, IdleConnTimeout: 60 * time.Second, TLSHandshakeTimeout: 10 * time.Second}
	if cfg.CAFile != "" {
		if pool, err := loadCAPool(cfg.CAFile); err == nil {
			tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		}
	}
	return &Client{Base: cfg.ServerURL, KeyID: cfg.KeyID, Secret: cfg.Secret, Version: version, Now: time.Now, HTTP: &http.Client{Timeout: 40 * time.Second, Transport: tr}}
}

func (c *Client) Do(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	ts := strconv.FormatInt(c.Now().Unix(), 10)
	signPath := path // tanda tangan memakai path tanpa query string
	if i := strings.IndexByte(path, '?'); i >= 0 {
		signPath = path[:i]
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "aiops-agent/"+c.Version)
	req.Header.Set("X-Aiops-Key", c.KeyID)
	req.Header.Set("X-Aiops-Ts", ts)
	req.Header.Set("X-Aiops-Sig", Sign(c.Secret, ts, method, signPath, body))
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	c.SentBytes.Add(int64(len(body)))
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, b, nil
}

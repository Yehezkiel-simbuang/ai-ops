package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// API adalah yang dibutuhkan runner dari aplikasi; antarmuka supaya mudah diuji tanpa jaringan.
type API interface {
	next(ctx context.Context, info RunnerInfo, wait int) (*Job, error)
	stage(ctx context.Context, id int, r StageReport) (cancel bool, err error)
	heartbeat(ctx context.Context, id int) (cancel bool, err error)
	finish(ctx context.Context, id int, status, errMsg string) error
}

type httpAPI struct {
	base, secret string
	client       *http.Client
}

func (a *httpAPI) do(ctx context.Context, path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+a.secret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("aplikasi menjawab %d: %s", resp.StatusCode, bytes.TrimSpace(raw))
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func (a *httpAPI) next(ctx context.Context, info RunnerInfo, wait int) (*Job, error) {
	var out struct {
		Job *Job `json:"job"`
	}
	if err := a.do(ctx, "/loadgen/v1/next?wait="+strconv.Itoa(wait), info, &out); err != nil {
		return nil, err
	}
	return out.Job, nil
}

func (a *httpAPI) stage(ctx context.Context, id int, r StageReport) (bool, error) {
	var out struct {
		Cancel bool `json:"cancel"`
	}
	err := a.do(ctx, fmt.Sprintf("/loadgen/v1/jobs/%d/stage", id), r, &out)
	return out.Cancel, err
}

func (a *httpAPI) heartbeat(ctx context.Context, id int) (bool, error) {
	var out struct {
		Cancel bool `json:"cancel"`
	}
	err := a.do(ctx, fmt.Sprintf("/loadgen/v1/jobs/%d/heartbeat", id), map[string]any{}, &out)
	return out.Cancel, err
}

func (a *httpAPI) finish(ctx context.Context, id int, status, errMsg string) error {
	return a.do(ctx, fmt.Sprintf("/loadgen/v1/jobs/%d/finish", id), map[string]string{"status": status, "error": errMsg}, nil)
}

func newAPI(base, secret string) *httpAPI {
	return &httpAPI{base: base, secret: secret, client: &http.Client{Timeout: 45 * time.Second}}
}

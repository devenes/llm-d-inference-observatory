package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/telemetry"
)

func TestRealUpstreamStreamForwardingAndTrueTTFT(t *testing.T) {
	var receivedTraceparent, receivedObjective string
	upstreamMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedTraceparent = r.Header.Get("traceparent")
		receivedObjective = r.Header.Get("x-llm-d-inference-objective")

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("x-went-into-resp-headers", "true")
		w.Header().Set("x-gateway-destination-endpoint", "10.20.0.14:8000")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		flusher.Flush()

		// Send initial empty role chunk first
		_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n")
		flusher.Flush()

		time.Sleep(15 * time.Millisecond)

		// Send actual content tokens
		_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n")
		flusher.Flush()
		time.Sleep(8 * time.Millisecond)
		_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"llm-d!\"}}]}\n\n")
		flusher.Flush()
		_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer upstreamMock.Close()

	cfg := config.Default()
	cfg.MockMode = false
	cfg.UpstreamURL = upstreamMock.URL

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	tracer, err := telemetry.NewTracerManager(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewHub(50, true)
	metrics := telemetry.NewMetricsCollector(cfg)
	srv := New(cfg, logger, hub, tracer, metrics)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	reqBody := `{"model":"Qwen/Qwen2.5-0.5B-Instruct","prompt":"Test prompt","max_tokens":16,"stream":true,"priority_band":"premium-traffic"}`
	resp, err := http.Post(ts.URL+"/api/infer/stream", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatalf("POST /api/infer/stream failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected HTTP 200, got %d", resp.StatusCode)
	}
	reqID := resp.Header.Get("X-Request-Id")
	if reqID == "" {
		t.Fatal("missing X-Request-Id header")
	}
	streamBytes, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(streamBytes), "Hello ") || !strings.Contains(string(streamBytes), "[DONE]") {
		t.Fatalf("unexpected SSE stream body: %s", string(streamBytes))
	}
	if receivedTraceparent == "" {
		t.Fatal("expected W3C traceparent header to be propagated to upstream")
	}
	if receivedObjective != "premium-traffic" {
		t.Fatalf("expected x-llm-d-inference-objective=premium-traffic, got %q", receivedObjective)
	}

	rec, ok := hub.GetRequest(reqID)
	if !ok {
		t.Fatalf("expected request record %s in hub", reqID)
	}
	if rec.Status != "completed" {
		t.Fatalf("expected status completed, got %s", rec.Status)
	}
	if rec.Timings.TTFTMs.ObservationKind != events.ObservationMeasured || rec.Timings.TTFTMs.Value == nil {
		t.Fatalf("expected measured TTFTMs, got %+v", rec.Timings.TTFTMs)
	}
	if rec.Timings.UpstreamHeadersMs.Value == nil || *rec.Timings.TTFTMs.Value <= *rec.Timings.UpstreamHeadersMs.Value {
		t.Fatalf("expected True TTFT (%.2f ms) > HTTP headers arrival (%.2f ms) because initial empty role chunk was ignored",
			*rec.Timings.TTFTMs.Value, *rec.Timings.UpstreamHeadersMs.Value)
	}
	if rec.Timings.PrefillDurationMs.ObservationKind != events.ObservationUnavailable {
		t.Fatalf("expected prefill duration to remain unavailable without explicit prefill span, got %s", rec.Timings.PrefillDurationMs.ObservationKind)
	}

	for _, ev := range rec.Events {
		if ev.ObservationKind == events.ObservationSimulated {
			t.Fatalf("non-mock request must never emit simulated events, got %+v", ev)
		}
	}
}

func TestSecurityBoundariesAndMockScenarios(t *testing.T) {
	cfg := config.Default()
	cfg.MockMode = true
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	tracer, _ := telemetry.NewTracerManager(context.Background(), cfg)
	hub := events.NewHub(50, true)
	metrics := telemetry.NewMetricsCollector(cfg)
	srv := New(cfg, logger, hub, tracer, metrics)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 1. Reject arbitrary upstream_url override (SSRF defense)
	ssrfResp, err := http.Post(ts.URL+"/api/infer", "application/json",
		strings.NewReader(`{"model":"Qwen/Qwen2.5-0.5B-Instruct","prompt":"hi","upstream_url":"http://169.254.169.254"}`))
	if err != nil {
		t.Fatal(err)
	}
	ssrfResp.Body.Close()
	if ssrfResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected HTTP 400 when upstream_url is supplied by client, got %d", ssrfResp.StatusCode)
	}

	// 2. Reject unallowed model
	badModelResp, err := http.Post(ts.URL+"/api/infer", "application/json",
		strings.NewReader(`{"model":"evil/model","prompt":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	badModelResp.Body.Close()
	if badModelResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected HTTP 400 for unallowed model, got %d", badModelResp.StatusCode)
	}

	// 3. Mock success scenario: verify all events are marked simulated
	okResp, err := http.Post(ts.URL+"/api/infer/stream", "application/json",
		strings.NewReader(`{"model":"Qwen/Qwen2.5-0.5B-Instruct","prompt":"Explain EPP","max_tokens":10,"scenario":"success"}`))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.ReadAll(okResp.Body)
	okResp.Body.Close()
	reqID := okResp.Header.Get("X-Request-Id")
	rec, exists := hub.GetRequest(reqID)
	if !exists || len(rec.Events) == 0 {
		t.Fatal("expected simulated request events")
	}
	for _, ev := range rec.Events {
		if ev.ObservationKind != events.ObservationSimulated {
			t.Fatalf("every mock event must have observation_kind=simulated, got %s on %s", ev.ObservationKind, ev.EventType)
		}
	}

	// 4. Mock saturated scenario (HTTP 429)
	satResp, err := http.Post(ts.URL+"/api/infer", "application/json",
		strings.NewReader(`{"model":"Qwen/Qwen2.5-0.5B-Instruct","prompt":"Burst","scenario":"saturated"}`))
	if err != nil {
		t.Fatal(err)
	}
	satResp.Body.Close()
	if satResp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected HTTP 429 for saturated scenario, got %d", satResp.StatusCode)
	}

	// 5. Client cancellation mid-stream
	cancelCtx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	cReq, _ := http.NewRequestWithContext(cancelCtx, http.MethodPost, ts.URL+"/api/infer/stream",
		bytes.NewBufferString(`{"model":"Qwen/Qwen2.5-0.5B-Instruct","prompt":"Cancel me","max_tokens":40,"scenario":"cancel"}`))
	cReq.Header.Set("Content-Type", "application/json")
	cResp, err := http.DefaultClient.Do(cReq)
	if err == nil {
		_, _ = io.ReadAll(cResp.Body)
		cResp.Body.Close()
	}
	time.Sleep(80 * time.Millisecond)

	reqs := hub.ListRequests(5)
	foundCancel := false
	for _, r := range reqs {
		if r.Scenario == "cancel" && r.Status == "cancelled" {
			foundCancel = true
			break
		}
	}
	if !foundCancel {
		t.Fatal("expected cancelled request to be recorded with status=cancelled")
	}

	// 6. Verify SSE /api/requests/{id}/events endpoint
	evReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/requests/"+reqID+"/events", nil)
	evReq.Header.Set("Accept", "text/event-stream")
	evResp, err := http.DefaultClient.Do(evReq)
	if err != nil {
		t.Fatal(err)
	}
	evBody, _ := io.ReadAll(evResp.Body)
	evResp.Body.Close()
	if !strings.Contains(string(evBody), "event: request.accepted") || !strings.Contains(string(evBody), "event: request.completed") {
		t.Fatalf("expected SSE lifecycle events, got:\n%s", string(evBody))
	}

	// 7. Verify /api/requests/{id}/trace endpoint
	trResp, err := http.Get(ts.URL + "/api/requests/" + reqID + "/trace")
	if err != nil {
		t.Fatal(err)
	}
	var tr events.TraceRecord
	_ = json.NewDecoder(trResp.Body).Decode(&tr)
	trResp.Body.Close()
	if tr.ObservationKind != events.ObservationSimulated || len(tr.Spans) == 0 {
		t.Fatalf("expected simulated trace spans, got %+v", tr)
	}
}

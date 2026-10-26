package benchmark

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/server"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/telemetry"
)

func TestBenchmarkHarnessStreamingAndExport(t *testing.T) {
	cfg := config.Default()
	cfg.MockMode = true
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	tracer, _ := telemetry.NewTracerManager(context.Background(), cfg)
	hub := events.NewHub(100, true)
	metrics := telemetry.NewMetricsCollector(cfg)
	srv := server.New(cfg, logger, hub, tracer, metrics)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	report, err := Run(context.Background(), RunConfig{
		TargetURL:      ts.URL,
		Environment:    EnvMock,
		Model:          "Qwen/Qwen2.5-0.5B-Instruct",
		RouterMode:     "optimized-baseline",
		PriorityBand:   "standard-traffic",
		PromptProfile:  "short",
		OutputProfile:  "short",
		Stream:         true,
		Scenario:       "success",
		WarmupRequests: 1,
		MeasuredReqs:   3,
		Concurrency:    2,
		RequestTimeout: 10 * time.Second,
		Seed:           42,
	})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if !report.IsSimulated || report.Environment != EnvMock {
		t.Fatalf("expected mock benchmark run to be marked IsSimulated=true, got %+v", report)
	}
	if !report.ScenarioPassed || report.CompletedCount != 3 {
		t.Fatalf("expected 3 completed requests and ScenarioPassed=true, got %+v", report)
	}
	if report.TTFTDistributionMs.Count != 3 || report.ITLDistributionMs.Count == 0 {
		t.Fatalf("expected TTFT and ITL distributions to be populated, got ttft=%+v itl=%+v",
			report.TTFTDistributionMs, report.ITLDistributionMs)
	}

	tmpDir := t.TempDir()
	jsonPath := filepath.Join(tmpDir, "bench.json")
	csvPath := filepath.Join(tmpDir, "bench.csv")
	if err := WriteJSON(jsonPath, report); err != nil {
		t.Fatalf("WriteJSON failed: %v", err)
	}
	if err := WriteCSV(csvPath, report); err != nil {
		t.Fatalf("WriteCSV failed: %v", err)
	}
	if st, err := os.Stat(jsonPath); err != nil || st.Size() == 0 {
		t.Fatal("expected non-empty JSON report file")
	}
	if st, err := os.Stat(csvPath); err != nil || st.Size() == 0 {
		t.Fatal("expected non-empty CSV report file")
	}
}

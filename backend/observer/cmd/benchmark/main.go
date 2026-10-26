package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/benchmark"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/server"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/telemetry"
)

func main() {
	var (
		targetURL     = flag.String("target-url", "http://localhost:8080", "Target Observer API base URL")
		inProcessMock = flag.Bool("in-process-mock", false, "Start an ephemeral in-process mock Observer API server for deterministic fixture benchmarks")
		envMode       = flag.String("environment", "mock", "Execution environment label: mock | local-cpu | live-gke")
		model         = flag.String("model", "Qwen/Qwen2.5-0.5B-Instruct", "Model identifier")
		routerMode    = flag.String("router-mode", "optimized-baseline", "Router mode: optimized-baseline | precise-prefix-cache | flow-control")
		priorityBand  = flag.String("priority-band", "standard-traffic", "Priority band: premium-traffic | standard-traffic | best-effort-traffic")
		promptProfile = flag.String("prompt-profile", "short", "Prompt profile: short | long")
		outputProfile = flag.String("output-profile", "short", "Output profile: short | long")
		stream        = flag.Bool("stream", true, "Use SSE streaming endpoint")
		scenario      = flag.String("scenario", "success", "Scenario: success | delay | saturated | cancel")
		warmup        = flag.Int("warmup", 1, "Number of warm-up requests before measurement")
		requests      = flag.Int("requests", 4, "Number of measured requests")
		concurrency   = flag.Int("concurrency", 2, "Concurrent request workers")
		rateRPS       = flag.Float64("rate-rps", 0, "Controlled arrival rate in requests/sec (0 = unbounded)")
		cancelAfterMs = flag.Int("cancel-after-ms", 0, "Cancel in-flight request after N milliseconds (0 = disabled)")
		timeoutSec    = flag.Int("timeout-sec", 30, "Per-request timeout in seconds")
		seed          = flag.Int64("seed", 42, "Deterministic prompt seed")
		jsonOut       = flag.String("json-out", "", "Optional path to write JSON benchmark report")
		csvOut        = flag.String("csv-out", "", "Optional path to write CSV sample results")
	)
	flag.Parse()

	ctx := context.Background()

	if *inProcessMock {
		cfg := config.Default()
		cfg.MockMode = true
		silentLogger := slog.New(slog.NewTextHandler(io.Discard, nil))
		tracer, _ := telemetry.NewTracerManager(ctx, cfg)
		hub := events.NewHub(cfg.MaxRetainedRequests, cfg.RedactPrompts)
		metrics := telemetry.NewMetricsCollector(cfg)
		srv := server.New(cfg, silentLogger, hub, tracer, metrics)
		ts := httptest.NewServer(srv.Handler())
		defer ts.Close()
		*targetURL = ts.URL
		*envMode = string(benchmark.EnvMock)
	}

	runCfg := benchmark.RunConfig{
		TargetURL:      *targetURL,
		Environment:    benchmark.EnvironmentMode(*envMode),
		Model:          *model,
		RouterMode:     *routerMode,
		PriorityBand:   *priorityBand,
		PromptProfile:  *promptProfile,
		OutputProfile:  *outputProfile,
		Stream:         *stream,
		Scenario:       *scenario,
		WarmupRequests: *warmup,
		MeasuredReqs:   *requests,
		Concurrency:    *concurrency,
		ArrivalRateRPS: *rateRPS,
		CancelAfterMs:  *cancelAfterMs,
		RequestTimeout: time.Duration(*timeoutSec) * time.Second,
		Seed:           *seed,
	}

	report, err := benchmark.Run(ctx, runCfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "benchmark error: %v\n", err)
		os.Exit(1)
	}

	if *jsonOut != "" {
		if err := benchmark.WriteJSON(*jsonOut, report); err != nil {
			fmt.Fprintf(os.Stderr, "failed writing JSON report: %v\n", err)
			os.Exit(1)
		}
	}
	if *csvOut != "" {
		if err := benchmark.WriteCSV(*csvOut, report); err != nil {
			fmt.Fprintf(os.Stderr, "failed writing CSV report: %v\n", err)
			os.Exit(1)
		}
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(report)

	if !report.ScenarioPassed {
		os.Exit(2)
	}
}

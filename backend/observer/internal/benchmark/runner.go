package benchmark

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// EnvironmentMode explicitly records whether a benchmark run targeted mock, local-cpu, or gke.
type EnvironmentMode string

const (
	EnvMock     EnvironmentMode = "mock"
	EnvLocalCPU EnvironmentMode = "local-cpu"
	EnvLiveGKE  EnvironmentMode = "live-gke"
)

// RunConfig specifies benchmark parameters.
type RunConfig struct {
	TargetURL      string          `json:"target_url"`
	Environment    EnvironmentMode `json:"environment"`
	Model          string          `json:"model"`
	RouterMode     string          `json:"router_mode"`
	PriorityBand   string          `json:"priority_band"`
	PromptProfile  string          `json:"prompt_profile"` // short | long
	OutputProfile  string          `json:"output_profile"` // short | long
	Stream         bool            `json:"stream"`
	Scenario       string          `json:"scenario"` // success | delay | saturated | cancel
	WarmupRequests int             `json:"warmup_requests"`
	MeasuredReqs   int             `json:"measured_requests"`
	Concurrency    int             `json:"concurrency"`
	ArrivalRateRPS float64         `json:"arrival_rate_rps"`
	CancelAfterMs  int             `json:"cancel_after_ms"`
	RequestTimeout time.Duration   `json:"request_timeout"`
	Seed           int64           `json:"seed"`
}

// SampleResult records timings and status for one measured request.
type SampleResult struct {
	Index            int       `json:"index"`
	RequestID        string    `json:"request_id"`
	Phase            string    `json:"phase"`  // warmup | measured
	Status           string    `json:"status"` // completed | cancelled | failed
	HTTPStatus       int       `json:"http_status"`
	TTFBMs           *float64  `json:"ttfb_ms"`
	TTFTMs           *float64  `json:"ttft_ms"`
	DurationMs       float64   `json:"duration_ms"`
	MeanITLMs        *float64  `json:"mean_itl_ms"`
	P95ITLMs         *float64  `json:"p95_itl_ms"`
	PromptTokens     int       `json:"prompt_tokens"`
	CompletionTokens int       `json:"completion_tokens"`
	TokensPerSec     float64   `json:"tokens_per_sec"`
	ErrorMessage     string    `json:"error_message,omitempty"`
	ITLSamplesMs     []float64 `json:"-"`
}

// DistributionStats summarizes a metric distribution across measured requests.
type DistributionStats struct {
	Count int      `json:"count"`
	Min   *float64 `json:"min"`
	P50   *float64 `json:"p50"`
	P95   *float64 `json:"p95"`
	P99   *float64 `json:"p99"`
	Max   *float64 `json:"max"`
	Mean  *float64 `json:"mean"`
}

// BenchmarkReport is the complete benchmark output exported as JSON/CSV.
type BenchmarkReport struct {
	Timestamp             string            `json:"timestamp"`
	Environment           EnvironmentMode   `json:"environment"`
	IsSimulated           bool              `json:"is_simulated"`
	ProvenanceNote        string            `json:"provenance_note"`
	Config                RunConfig         `json:"config"`
	ScenarioPassed        bool              `json:"scenario_passed"`
	WarmupCount           int               `json:"warmup_count"`
	MeasuredCount         int               `json:"measured_count"`
	CompletedCount        int               `json:"completed_count"`
	CancelledCount        int               `json:"cancelled_count"`
	HTTPFailureCount      int               `json:"http_failure_count"`
	TotalInputTokens      int               `json:"total_input_tokens"`
	TotalOutputTokens     int               `json:"total_output_tokens"`
	WallClockDurationMs   float64           `json:"wall_clock_duration_ms"`
	AggregateTokensPerSec float64           `json:"aggregate_tokens_per_sec"`
	TTFBDistributionMs    DistributionStats `json:"ttfb_distribution_ms"`
	TTFTDistributionMs    DistributionStats `json:"ttft_distribution_ms"`
	E2EDistributionMs     DistributionStats `json:"e2e_distribution_ms"`
	ITLDistributionMs     DistributionStats `json:"itl_distribution_ms"`
	Samples               []SampleResult    `json:"samples"`
}

// DeterministicPrompts provides repeatable short and long prompts for reproducible runs.
func DeterministicPrompt(profile string, index int, seed int64) (string, int) {
	if strings.EqualFold(profile, "long") {
		base := fmt.Sprintf("[Seed=%d Req=%d] Explain in detail how the llm-d Endpoint Picker (EPP) combines approximate or ZMQ-backed precise prefix-cache affinity filtering with in-flight token load scoring on CPU-only Google Kubernetes Engine (Intel Sapphire Rapids C3 nodes), and contrast True Time To First Token (first non-empty delta.content token) with HTTP response header arrival.", seed, index)
		repeated := strings.Repeat(base+" ", 4)
		return repeated, (len([]rune(repeated)) + 3) / 4
	}
	short := fmt.Sprintf("[Seed=%d Req=%d] Summarize the role of the Endpoint Picker (EPP) in llm-d inference routing.", seed, index)
	return short, (len([]rune(short)) + 3) / 4
}

// OutputMaxTokens maps output_profile ("short" or "long") to deterministic max_tokens.
func OutputMaxTokens(profile string) int {
	if strings.EqualFold(profile, "long") {
		return 64
	}
	return 16
}

// Run executes the warmup and measured phases and produces a BenchmarkReport.
func Run(ctx context.Context, cfg RunConfig) (*BenchmarkReport, error) {
	if cfg.TargetURL == "" {
		return nil, fmt.Errorf("target_url is required")
	}
	if cfg.Environment == "" {
		cfg.Environment = EnvMock
	}
	if cfg.Model == "" {
		cfg.Model = "Qwen/Qwen2.5-0.5B-Instruct"
	}
	if cfg.RouterMode == "" {
		cfg.RouterMode = "optimized-baseline"
	}
	if cfg.PriorityBand == "" {
		cfg.PriorityBand = "standard-traffic"
	}
	if cfg.PromptProfile == "" {
		cfg.PromptProfile = "short"
	}
	if cfg.OutputProfile == "" {
		cfg.OutputProfile = "short"
	}
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 1
	}
	if cfg.MeasuredReqs <= 0 {
		cfg.MeasuredReqs = 1
	}
	if cfg.RequestTimeout <= 0 {
		cfg.RequestTimeout = 30 * time.Second
	}

	client := &http.Client{
		Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 100,
			IdleConnTimeout:     90 * time.Second,
		},
	}

	// Phase 1: Warm-up requests (excluded from measured statistics)
	for w := 0; w < cfg.WarmupRequests; w++ {
		if ctx.Err() != nil {
			break
		}
		_ = executeSingle(ctx, client, cfg, w, "warmup")
	}

	// Phase 2: Measured requests with concurrency and controlled arrival rate
	measuredStart := time.Now()
	results := make([]SampleResult, cfg.MeasuredReqs)
	sem := make(chan struct{}, cfg.Concurrency)
	var wg sync.WaitGroup

	var arrivalInterval time.Duration
	if cfg.ArrivalRateRPS > 0 {
		arrivalInterval = time.Duration(float64(time.Second) / cfg.ArrivalRateRPS)
	}

	for i := 0; i < cfg.MeasuredReqs; i++ {
		if arrivalInterval > 0 && i > 0 {
			select {
			case <-ctx.Done():
			case <-time.After(arrivalInterval):
			}
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int) {
			defer wg.Done()
			defer func() { <-sem }()
			results[idx] = executeSingle(ctx, client, cfg, idx, "measured")
		}(i)
	}
	wg.Wait()
	wallDur := time.Since(measuredStart)

	return summarizeReport(cfg, results, wallDur), nil
}

func executeSingle(parentCtx context.Context, client *http.Client, cfg RunConfig, idx int, phase string) SampleResult {
	promptText, estPromptToks := DeterministicPrompt(cfg.PromptProfile, idx, cfg.Seed)
	maxToks := OutputMaxTokens(cfg.OutputProfile)

	reqCtx, cancel := context.WithTimeout(parentCtx, cfg.RequestTimeout)
	if cfg.CancelAfterMs > 0 {
		reqCtx, cancel = context.WithTimeout(parentCtx, time.Duration(cfg.CancelAfterMs)*time.Millisecond)
	}
	defer cancel()

	payload := map[string]any{
		"model":         cfg.Model,
		"prompt":        promptText,
		"max_tokens":    maxToks,
		"stream":        cfg.Stream,
		"router_mode":   cfg.RouterMode,
		"priority_band": cfg.PriorityBand,
		"scenario":      cfg.Scenario,
	}
	bodyBytes, _ := json.Marshal(payload)

	endpoint := strings.TrimRight(cfg.TargetURL, "/") + "/api/infer"
	if cfg.Stream {
		endpoint = strings.TrimRight(cfg.TargetURL, "/") + "/api/infer/stream"
	}

	start := time.Now()
	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return SampleResult{
			Index:        idx,
			Phase:        phase,
			Status:       "failed",
			ErrorMessage: err.Error(),
		}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if cfg.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		durMs := round2(float64(time.Since(start).Nanoseconds()) / 1e6)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || cfg.CancelAfterMs > 0 {
			return SampleResult{
				Index:        idx,
				Phase:        phase,
				Status:       "cancelled",
				HTTPStatus:   499,
				DurationMs:   durMs,
				PromptTokens: estPromptToks,
			}
		}
		return SampleResult{
			Index:        idx,
			Phase:        phase,
			Status:       "failed",
			DurationMs:   durMs,
			ErrorMessage: err.Error(),
		}
	}
	defer resp.Body.Close()

	ttfbMs := round2(float64(time.Since(start).Nanoseconds()) / 1e6)
	reqID := resp.Header.Get("X-Request-Id")

	if resp.StatusCode >= 400 {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		durMs := round2(float64(time.Since(start).Nanoseconds()) / 1e6)
		return SampleResult{
			Index:        idx,
			RequestID:    reqID,
			Phase:        phase,
			Status:       "failed",
			HTTPStatus:   resp.StatusCode,
			TTFBMs:       &ttfbMs,
			DurationMs:   durMs,
			PromptTokens: estPromptToks,
			ErrorMessage: strings.TrimSpace(string(errBody)),
		}
	}

	if !cfg.Stream {
		raw, readErr := io.ReadAll(resp.Body)
		durMs := round2(float64(time.Since(start).Nanoseconds()) / 1e6)
		if readErr != nil && cfg.CancelAfterMs > 0 {
			return SampleResult{
				Index:        idx,
				RequestID:    reqID,
				Phase:        phase,
				Status:       "cancelled",
				HTTPStatus:   499,
				TTFBMs:       &ttfbMs,
				DurationMs:   durMs,
				PromptTokens: estPromptToks,
			}
		}
		var parsed struct {
			Usage struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
			} `json:"usage"`
		}
		_ = json.Unmarshal(raw, &parsed)
		compToks := parsed.Usage.CompletionTokens
		if compToks == 0 {
			compToks = maxToks
		}
		tps := 0.0
		if durMs > 0 {
			tps = round2(float64(compToks) / (durMs / 1000.0))
		}
		return SampleResult{
			Index:            idx,
			RequestID:        reqID,
			Phase:            phase,
			Status:           "completed",
			HTTPStatus:       resp.StatusCode,
			TTFBMs:           &ttfbMs,
			DurationMs:       durMs,
			PromptTokens:     estPromptToks,
			CompletionTokens: compToks,
			TokensPerSec:     tps,
		}
	}

	// Streaming SSE parser measuring True TTFT and ITL
	scanner := bufio.NewScanner(resp.Body)
	var (
		ttftMs        *float64
		lastTokenTime time.Time
		itlSamples    []float64
		compToks      int
	)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		dataStr := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if dataStr == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(dataStr), &chunk); err != nil || len(chunk.Choices) == 0 {
			continue
		}
		if chunk.Choices[0].Delta.Content == "" {
			continue
		}
		now := time.Now()
		compToks++
		if ttftMs == nil {
			v := round2(float64(now.Sub(start).Nanoseconds()) / 1e6)
			ttftMs = &v
			lastTokenTime = now
		} else {
			itl := round2(float64(now.Sub(lastTokenTime).Nanoseconds()) / 1e6)
			lastTokenTime = now
			itlSamples = append(itlSamples, itl)
		}
	}

	durMs := round2(float64(time.Since(start).Nanoseconds()) / 1e6)
	if scanner.Err() != nil && (errors.Is(reqCtx.Err(), context.Canceled) || errors.Is(reqCtx.Err(), context.DeadlineExceeded) || cfg.CancelAfterMs > 0) {
		return SampleResult{
			Index:            idx,
			RequestID:        reqID,
			Phase:            phase,
			Status:           "cancelled",
			HTTPStatus:       499,
			TTFBMs:           &ttfbMs,
			TTFTMs:           ttftMs,
			DurationMs:       durMs,
			PromptTokens:     estPromptToks,
			CompletionTokens: compToks,
			ITLSamplesMs:     itlSamples,
		}
	}

	meanITL := calcStats(itlSamples).Mean
	p95ITL := calcStats(itlSamples).P95
	tps := 0.0
	if durMs > 0 {
		tps = round2(float64(compToks) / (durMs / 1000.0))
	}

	return SampleResult{
		Index:            idx,
		RequestID:        reqID,
		Phase:            phase,
		Status:           "completed",
		HTTPStatus:       resp.StatusCode,
		TTFBMs:           &ttfbMs,
		TTFTMs:           ttftMs,
		DurationMs:       durMs,
		MeanITLMs:        meanITL,
		P95ITLMs:         p95ITL,
		PromptTokens:     estPromptToks,
		CompletionTokens: compToks,
		TokensPerSec:     tps,
		ITLSamplesMs:     itlSamples,
	}
}

func summarizeReport(cfg RunConfig, samples []SampleResult, wallDur time.Duration) *BenchmarkReport {
	var (
		completed  int
		cancelled  int
		failed     int
		inToks     int
		outToks    int
		ttfbValues []float64
		ttftValues []float64
		e2eValues  []float64
		allITL     []float64
	)

	for _, s := range samples {
		inToks += s.PromptTokens
		outToks += s.CompletionTokens
		if s.TTFBMs != nil {
			ttfbValues = append(ttfbValues, *s.TTFBMs)
		}
		if s.TTFTMs != nil {
			ttftValues = append(ttftValues, *s.TTFTMs)
		}
		if s.Status == "completed" {
			completed++
			e2eValues = append(e2eValues, s.DurationMs)
			allITL = append(allITL, s.ITLSamplesMs...)
		} else if s.Status == "cancelled" {
			cancelled++
		} else {
			failed++
		}
	}

	wallMs := round2(float64(wallDur.Nanoseconds()) / 1e6)
	aggTps := 0.0
	if wallDur.Seconds() > 0 {
		aggTps = round2(float64(outToks) / wallDur.Seconds())
	}

	// Never mark a scenario passed merely because the runner exited!
	// Verify outcome matches the intended scenario semantics.
	scenarioPassed := false
	switch strings.ToLower(cfg.Scenario) {
	case "saturated", "failed", "upstream_error":
		scenarioPassed = failed > 0 && completed == 0
	case "cancel":
		scenarioPassed = cancelled > 0
	default:
		scenarioPassed = completed == len(samples) && failed == 0
	}

	isSim := cfg.Environment == EnvMock
	note := "Measured against live GKE llm-d deployment."
	if cfg.Environment == EnvMock {
		note = "SIMULATED FIXTURE RUN: Executed against local mock mode (OBSERVER_MOCK_MODE=true). Do not interpret as live GKE or vLLM CPU performance."
	} else if cfg.Environment == EnvLocalCPU {
		note = "Measured against local CPU container environment."
	}

	return &BenchmarkReport{
		Timestamp:             time.Now().UTC().Format(time.RFC3339Nano),
		Environment:           cfg.Environment,
		IsSimulated:           isSim,
		ProvenanceNote:        note,
		Config:                cfg,
		ScenarioPassed:        scenarioPassed,
		WarmupCount:           cfg.WarmupRequests,
		MeasuredCount:         len(samples),
		CompletedCount:        completed,
		CancelledCount:        cancelled,
		HTTPFailureCount:      failed,
		TotalInputTokens:      inToks,
		TotalOutputTokens:     outToks,
		WallClockDurationMs:   wallMs,
		AggregateTokensPerSec: aggTps,
		TTFBDistributionMs:    calcStats(ttfbValues),
		TTFTDistributionMs:    calcStats(ttftValues),
		E2EDistributionMs:     calcStats(e2eValues),
		ITLDistributionMs:     calcStats(allITL),
		Samples:               samples,
	}
}

// WriteJSON exports the BenchmarkReport to a JSON file.
func WriteJSON(path string, report *BenchmarkReport) error {
	b, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// WriteCSV exports per-request sample results to a CSV file.
func WriteCSV(path string, report *BenchmarkReport) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	w := csv.NewWriter(f)
	defer w.Flush()

	header := []string{
		"environment", "is_simulated", "index", "request_id", "status", "http_status",
		"ttfb_ms", "ttft_ms", "duration_ms", "mean_itl_ms", "p95_itl_ms",
		"prompt_tokens", "completion_tokens", "tokens_per_sec", "error_message",
	}
	if err := w.Write(header); err != nil {
		return err
	}

	fmtOpt := func(v *float64) string {
		if v == nil {
			return ""
		}
		return fmt.Sprintf("%.2f", *v)
	}

	for _, s := range report.Samples {
		row := []string{
			string(report.Environment),
			fmt.Sprintf("%t", report.IsSimulated),
			fmt.Sprintf("%d", s.Index),
			s.RequestID,
			s.Status,
			fmt.Sprintf("%d", s.HTTPStatus),
			fmtOpt(s.TTFBMs),
			fmtOpt(s.TTFTMs),
			fmt.Sprintf("%.2f", s.DurationMs),
			fmtOpt(s.MeanITLMs),
			fmtOpt(s.P95ITLMs),
			fmt.Sprintf("%d", s.PromptTokens),
			fmt.Sprintf("%d", s.CompletionTokens),
			fmt.Sprintf("%.2f", s.TokensPerSec),
			s.ErrorMessage,
		}
		if err := w.Write(row); err != nil {
			return err
		}
	}
	return nil
}

func calcStats(vals []float64) DistributionStats {
	if len(vals) == 0 {
		return DistributionStats{Count: 0}
	}
	sorted := make([]float64, len(vals))
	copy(sorted, vals)
	sort.Float64s(sorted)

	var sum float64
	for _, v := range sorted {
		sum += v
	}
	minVal := round2(sorted[0])
	maxVal := round2(sorted[len(sorted)-1])
	meanVal := round2(sum / float64(len(sorted)))
	p50 := pickPct(sorted, 0.50)
	p95 := pickPct(sorted, 0.95)
	p99 := pickPct(sorted, 0.99)

	return DistributionStats{
		Count: len(sorted),
		Min:   &minVal,
		P50:   &p50,
		P95:   &p95,
		P99:   &p99,
		Max:   &maxVal,
		Mean:  &meanVal,
	}
}

func pickPct(sorted []float64, p float64) float64 {
	idx := int(math.Ceil(p*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return round2(sorted[idx])
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

package telemetry

import (
	"bufio"
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
)

// MetricSeries represents a single aggregate metric exposed to the UI.
type MetricSeries struct {
	Name            string                 `json:"name"`
	Label           string                 `json:"label"`
	Category        string                 `json:"category"` // observer | epp | vllm | resource
	Value           *float64               `json:"value"`
	Unit            string                 `json:"unit"`
	ObservationKind events.ObservationKind `json:"observation_kind"`
	Source          string                 `json:"source"`
	Explanation     string                 `json:"explanation"`
}

// MetricsSummary is returned by GET /api/metrics.
type MetricsSummary struct {
	CollectedAt         string                 `json:"collected_at"`
	MockMode            bool                   `json:"mock_mode"`
	ObservationScope    events.ObservationKind `json:"observation_scope"`
	ScopeNotice         string                 `json:"scope_notice"`
	EPPScrapeStatus     string                 `json:"epp_scrape_status"`
	VLLMScrapeStatus    string                 `json:"vllm_scrape_status"`
	Series              []MetricSeries         `json:"series"`
	RecentTTFTSamplesMs []float64              `json:"recent_ttft_samples_ms"`
	RecentITLSamplesMs  []float64              `json:"recent_itl_samples_ms"`
	RecentTpsSamples    []float64              `json:"recent_tps_samples"`
}

// MetricsCollector tracks Observer API metrics and scrapes upstream Prometheus endpoints.
type MetricsCollector struct {
	mu                sync.RWMutex
	cfg               config.Config
	httpClient        *http.Client
	inFlight          int64
	totalRequests     int64
	completedRequests int64
	cancelledRequests int64
	failedRequests    int64
	promptTokensTotal int64
	outputTokensTotal int64
	ttftSamplesMs     []float64
	itlSamplesMs      []float64
	durationSamplesMs []float64
	tpsSamples        []float64
	forceMissing      bool
}

// NewMetricsCollector creates a new MetricsCollector.
func NewMetricsCollector(cfg config.Config) *MetricsCollector {
	return &MetricsCollector{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 2500 * time.Millisecond,
		},
		ttftSamplesMs:     make([]float64, 0, 100),
		itlSamplesMs:      make([]float64, 0, 100),
		durationSamplesMs: make([]float64, 0, 100),
		tpsSamples:        make([]float64, 0, 100),
	}
}

// SetForceMissing toggles the missing-metrics simulation scenario in mock mode.
func (mc *MetricsCollector) SetForceMissing(missing bool) {
	mc.mu.Lock()
	defer mc.mu.Unlock()
	mc.forceMissing = missing
}

// IncInFlight increments the active request gauge.
func (mc *MetricsCollector) IncInFlight() {
	mc.mu.Lock()
	defer mc.mu.Unlock()
	mc.inFlight++
	mc.totalRequests++
}

// RecordCompletion updates counters and rolling latency distributions when a request finishes.
func (mc *MetricsCollector) RecordCompletion(status string, ttftMs, meanITLMs, durationMs, tps *float64, promptTokens, outputTokens int) {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	if mc.inFlight > 0 {
		mc.inFlight--
	}
	switch status {
	case "completed":
		mc.completedRequests++
	case "cancelled":
		mc.cancelledRequests++
	default:
		mc.failedRequests++
	}
	mc.promptTokensTotal += int64(promptTokens)
	mc.outputTokensTotal += int64(outputTokens)

	if ttftMs != nil {
		mc.ttftSamplesMs = appendBounded(mc.ttftSamplesMs, *ttftMs, 100)
	}
	if meanITLMs != nil {
		mc.itlSamplesMs = appendBounded(mc.itlSamplesMs, *meanITLMs, 100)
	}
	if durationMs != nil {
		mc.durationSamplesMs = appendBounded(mc.durationSamplesMs, *durationMs, 100)
	}
	if tps != nil {
		mc.tpsSamples = appendBounded(mc.tpsSamples, *tps, 100)
	}
}

// RenderPrometheus outputs Observer API metrics in standard Prometheus text exposition format.
func (mc *MetricsCollector) RenderPrometheus() string {
	mc.mu.RLock()
	defer mc.mu.RUnlock()

	var b strings.Builder
	b.WriteString("# HELP observer_requests_total Total inference requests received by the Observer API.\n")
	b.WriteString("# TYPE observer_requests_total counter\n")
	fmt.Fprintf(&b, "observer_requests_total{status=\"completed\"} %d\n", mc.completedRequests)
	fmt.Fprintf(&b, "observer_requests_total{status=\"cancelled\"} %d\n", mc.cancelledRequests)
	fmt.Fprintf(&b, "observer_requests_total{status=\"failed\"} %d\n", mc.failedRequests)

	b.WriteString("# HELP observer_requests_in_flight Current number of in-flight inference requests.\n")
	b.WriteString("# TYPE observer_requests_in_flight gauge\n")
	fmt.Fprintf(&b, "observer_requests_in_flight %d\n", mc.inFlight)

	b.WriteString("# HELP observer_prompt_tokens_total Total input prompt tokens observed.\n")
	b.WriteString("# TYPE observer_prompt_tokens_total counter\n")
	fmt.Fprintf(&b, "observer_prompt_tokens_total %d\n", mc.promptTokensTotal)

	b.WriteString("# HELP observer_generation_tokens_total Total generated output tokens observed.\n")
	b.WriteString("# TYPE observer_generation_tokens_total counter\n")
	fmt.Fprintf(&b, "observer_generation_tokens_total %d\n", mc.outputTokensTotal)

	if p50 := percentile(mc.ttftSamplesMs, 0.50); p50 != nil {
		b.WriteString("# HELP observer_ttft_p50_milliseconds Median Time To First Token across recent requests.\n")
		b.WriteString("# TYPE observer_ttft_p50_milliseconds gauge\n")
		fmt.Fprintf(&b, "observer_ttft_p50_milliseconds %.2f\n", *p50)
	}
	return b.String()
}

// GetSummary returns structured aggregate metrics for the UI Metrics screen.
func (mc *MetricsCollector) GetSummary(ctx context.Context) MetricsSummary {
	mc.mu.RLock()
	inFlight := float64(mc.inFlight)
	completed := float64(mc.completedRequests)
	cancelled := float64(mc.cancelledRequests)
	failed := float64(mc.failedRequests)
	promptToks := float64(mc.promptTokensTotal)
	outputToks := float64(mc.outputTokensTotal)
	ttftP50 := percentile(mc.ttftSamplesMs, 0.50)
	ttftP95 := percentile(mc.ttftSamplesMs, 0.95)
	itlP50 := percentile(mc.itlSamplesMs, 0.50)
	durP50 := percentile(mc.durationSamplesMs, 0.50)
	tpsMean := meanSlice(mc.tpsSamples)
	ttftCopy := append([]float64(nil), mc.ttftSamplesMs...)
	itlCopy := append([]float64(nil), mc.itlSamplesMs...)
	tpsCopy := append([]float64(nil), mc.tpsSamples...)
	forceMissing := mc.forceMissing
	mc.mu.RUnlock()

	aggKind := events.ObservationAggregate
	if mc.cfg.MockMode {
		aggKind = events.ObservationSimulated
	}

	series := []MetricSeries{
		{
			Name:            "observer_ttft_p50_ms",
			Label:           "Aggregate Median TTFT (p50)",
			Category:        "observer",
			Value:           ttftP50,
			Unit:            "ms",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Rolling median Time To First Token across recent requests measured by Observer API.",
		},
		{
			Name:            "observer_ttft_p95_ms",
			Label:           "Aggregate Tail TTFT (p95)",
			Category:        "observer",
			Value:           ttftP95,
			Unit:            "ms",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Rolling 95th percentile Time To First Token across recent requests.",
		},
		{
			Name:            "observer_itl_p50_ms",
			Label:           "Aggregate Median ITL (p50)",
			Category:        "observer",
			Value:           itlP50,
			Unit:            "ms",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Rolling median Inter-Token Latency across recent streaming requests.",
		},
		{
			Name:            "observer_decode_tokens_per_sec",
			Label:           "Mean Decode Throughput",
			Category:        "observer",
			Value:           tpsMean,
			Unit:            "tok/s",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Rolling average token generation speed across completed requests.",
		},
		{
			Name:            "observer_request_duration_p50_ms",
			Label:           "Median E2E Request Duration",
			Category:        "observer",
			Value:           durP50,
			Unit:            "ms",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Rolling median end-to-end request duration.",
		},
		{
			Name:            "observer_requests_in_flight",
			Label:           "Observer In-Flight Requests",
			Category:        "observer",
			Value:           &inFlight,
			Unit:            "requests",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Current active requests held open by the Observer API.",
		},
		{
			Name:            "observer_requests_completed_total",
			Label:           "Completed Requests",
			Category:        "observer",
			Value:           &completed,
			Unit:            "requests",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Cumulative successful inference requests observed since startup.",
		},
		{
			Name:            "observer_requests_cancelled_total",
			Label:           "Cancelled Requests",
			Category:        "observer",
			Value:           &cancelled,
			Unit:            "requests",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Cumulative client-cancelled inference requests.",
		},
		{
			Name:            "observer_requests_failed_total",
			Label:           "Failed / Rejected Requests",
			Category:        "observer",
			Value:           &failed,
			Unit:            "requests",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Cumulative HTTP 4xx/5xx or upstream error responses.",
		},
		{
			Name:            "observer_prompt_tokens_total",
			Label:           "Total Input Prompt Tokens",
			Category:        "observer",
			Value:           &promptToks,
			Unit:            "tokens",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Aggregate input tokens across requests.",
		},
		{
			Name:            "observer_generation_tokens_total",
			Label:           "Total Output Generation Tokens",
			Category:        "observer",
			Value:           &outputToks,
			Unit:            "tokens",
			ObservationKind: aggKind,
			Source:          "observer-api",
			Explanation:     "Aggregate generated output tokens across requests.",
		},
	}

	eppStatus := "unavailable"
	vllmStatus := "unavailable"

	if forceMissing {
		eppStatus = "missing_simulated"
		vllmStatus = "missing_simulated"
		series = append(series, unavailableUpstreamSeries()...)
	} else if mc.cfg.MockMode {
		eppStatus = "simulated"
		vllmStatus = "simulated"
		series = append(series, simulatedUpstreamSeries(completed, failed, inFlight, promptToks)...)
	} else {
		eppMap, eppErr := mc.scrapePrometheus(ctx, mc.cfg.EPPMetricsURL, mc.cfg.EPPBearerToken)
		if eppErr == nil {
			eppStatus = "scraped"
		}
		vllmMap, vllmErr := mc.scrapePrometheus(ctx, mc.cfg.VLLMMetricsURL, "")
		if vllmErr == nil {
			vllmStatus = "scraped"
		}
		series = append(series, buildLiveUpstreamSeries(eppMap, eppErr == nil, vllmMap, vllmErr == nil)...)
	}

	return MetricsSummary{
		CollectedAt:         time.Now().UTC().Format(time.RFC3339Nano),
		MockMode:            mc.cfg.MockMode,
		ObservationScope:    aggKind,
		ScopeNotice:         "Aggregate metrics describe system-wide counters and gauges over a scrape window. Never interpret a global queue gauge (such as llm_d_epp_flow_control_queue_size or vllm:num_requests_waiting) as an exact per-request queue wait duration.",
		EPPScrapeStatus:     eppStatus,
		VLLMScrapeStatus:    vllmStatus,
		Series:              series,
		RecentTTFTSamplesMs: ttftCopy,
		RecentITLSamplesMs:  itlCopy,
		RecentTpsSamples:    tpsCopy,
	}
}

func (mc *MetricsCollector) scrapePrometheus(ctx context.Context, targetURL, bearerToken string) (map[string]float64, error) {
	if targetURL == "" {
		return nil, fmt.Errorf("empty metrics URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	resp, err := mc.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, targetURL)
	}

	out := make(map[string]float64)
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := fields[0]
		if idx := strings.IndexByte(name, '{'); idx != -1 {
			name = name[:idx]
		}
		val, err := strconv.ParseFloat(fields[len(fields)-1], 64)
		if err == nil {
			out[name] += val
		}
	}
	return out, scanner.Err()
}

func simulatedUpstreamSeries(completed, failed, inFlight, promptToks float64) []MetricSeries {
	readyEndpoints := 2.0
	eppReqTotal := completed + failed
	kvLookupHits := math.Floor(completed * 14.0)
	predictedCachedToks := math.Floor(promptToks * 0.65)
	fcQueueSize := 0.0
	if inFlight > 2 {
		fcQueueSize = inFlight - 2
	}
	fcSaturation := math.Min(1.0, inFlight/4.0)
	vllmRunning := inFlight
	vllmWaiting := 0.0
	if inFlight > 4 {
		vllmWaiting = inFlight - 4
	}
	vllmCacheHitRate := 72.5
	cpuUtil := math.Min(95.0, 18.5+(inFlight*16.0))
	memUtil := 54.2

	return []MetricSeries{
		{
			Name:            "llm_d_epp_ready_endpoints",
			Label:           "EPP Ready Model Endpoints",
			Category:        "epp",
			Value:           &readyEndpoints,
			Unit:            "pods",
			ObservationKind: events.ObservationSimulated,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "Number of ready vLLM pods registered in the InferencePool (2 replicas on c3-standard-22).",
		},
		{
			Name:            "llm_d_epp_request_total",
			Label:           "EPP Total Routed Requests",
			Category:        "epp",
			Value:           &eppReqTotal,
			Unit:            "requests",
			ObservationKind: events.ObservationSimulated,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "Aggregate requests processed by the llm-d Endpoint Picker ext_proc filter.",
		},
		{
			Name:            "llm_d_epp_kv_cache_index_lookup_hits_total",
			Label:           "EPP KV-Cache Index Block Hits",
			Category:        "epp",
			Value:           &kvLookupHits,
			Unit:            "blocks",
			ObservationKind: events.ObservationSimulated,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "Aggregate 64-token KV block lookup hits in the EPP prefix cache indexer.",
		},
		{
			Name:            "llm_d_epp_prefix_predicted_cached_tokens_sum",
			Label:           "EPP Predicted Cached Tokens",
			Category:        "epp",
			Value:           &predictedCachedToks,
			Unit:            "tokens",
			ObservationKind: events.ObservationSimulated,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "Cumulative prompt tokens predicted by EPP to hit existing vLLM prefix caches.",
		},
		{
			Name:            "llm_d_epp_flow_control_queue_size",
			Label:           "EPP Flow-Control Queue Depth",
			Category:        "epp",
			Value:           &fcQueueSize,
			Unit:            "requests",
			ObservationKind: events.ObservationSimulated,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "System-wide gauge of requests currently buffered in EPP priority-band queues (not a single-request wait time).",
		},
		{
			Name:            "llm_d_epp_flow_control_pool_saturation",
			Label:           "EPP InferencePool Saturation",
			Category:        "epp",
			Value:           &fcSaturation,
			Unit:            "ratio",
			ObservationKind: events.ObservationSimulated,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "Aggregate saturation ratio across the InferencePool calculated by EPP concurrency detector.",
		},
		{
			Name:            "vllm:num_requests_running",
			Label:           "vLLM Active Running Requests",
			Category:        "vllm",
			Value:           &vllmRunning,
			Unit:            "requests",
			ObservationKind: events.ObservationSimulated,
			Source:          "vllm-model-server (:8000/metrics)",
			Explanation:     "Aggregate gauge of requests currently executing in the vLLM CPU scheduler.",
		},
		{
			Name:            "vllm:num_requests_waiting",
			Label:           "vLLM Scheduler Waiting Queue",
			Category:        "vllm",
			Value:           &vllmWaiting,
			Unit:            "requests",
			ObservationKind: events.ObservationSimulated,
			Source:          "vllm-model-server (:8000/metrics)",
			Explanation:     "Aggregate gauge of requests waiting in the vLLM internal scheduler queue.",
		},
		{
			Name:            "vllm:prefix_cache_hit_rate_pct",
			Label:           "vLLM Prefix Cache Hit Rate",
			Category:        "vllm",
			Value:           &vllmCacheHitRate,
			Unit:            "%",
			ObservationKind: events.ObservationSimulated,
			Source:          "vllm-model-server (:8000/metrics)",
			Explanation:     "Ratio of vllm:prefix_cache_hits_total to vllm:prefix_cache_queries_total across CPU model servers.",
		},
		{
			Name:            "node_cpu_utilization_pct",
			Label:           "CPU Inference Pool Utilization (c3-standard-22)",
			Category:        "resource",
			Value:           &cpuUtil,
			Unit:            "%",
			ObservationKind: events.ObservationSimulated,
			Source:          "kubelet / cAdvisor",
			Explanation:     "Aggregate CPU utilization across the 22-vCPU Intel Sapphire Rapids inference node.",
		},
		{
			Name:            "node_memory_utilization_pct",
			Label:           "Memory Utilization (c3-standard-22)",
			Category:        "resource",
			Value:           &memUtil,
			Unit:            "%",
			ObservationKind: events.ObservationSimulated,
			Source:          "kubelet / cAdvisor",
			Explanation:     "Aggregate memory utilization including 2x 4 GiB vLLM CPU KV-cache allocations.",
		},
	}
}

func unavailableUpstreamSeries() []MetricSeries {
	names := []struct {
		name, label, cat, unit, src, desc string
	}{
		{"llm_d_epp_ready_endpoints", "EPP Ready Model Endpoints", "epp", "pods", "llm-d-router-epp (:9090/metrics)", "Unavailable: EPP metrics endpoint could not be scraped."},
		{"llm_d_epp_flow_control_queue_size", "EPP Flow-Control Queue Depth", "epp", "requests", "llm-d-router-epp (:9090/metrics)", "Unavailable: EPP metrics endpoint could not be scraped."},
		{"vllm:num_requests_running", "vLLM Active Running Requests", "vllm", "requests", "vllm-model-server (:8000/metrics)", "Unavailable: vLLM metrics endpoint could not be scraped."},
		{"vllm:num_requests_waiting", "vLLM Scheduler Waiting Queue", "vllm", "requests", "vllm-model-server (:8000/metrics)", "Unavailable: vLLM metrics endpoint could not be scraped."},
	}
	out := make([]MetricSeries, 0, len(names))
	for _, n := range names {
		out = append(out, MetricSeries{
			Name:            n.name,
			Label:           n.label,
			Category:        n.cat,
			Value:           nil,
			Unit:            n.unit,
			ObservationKind: events.ObservationUnavailable,
			Source:          n.src,
			Explanation:     n.desc,
		})
	}
	return out
}

func buildLiveUpstreamSeries(eppMap map[string]float64, eppOK bool, vllmMap map[string]float64, vllmOK bool) []MetricSeries {
	lookup := func(m map[string]float64, ok bool, key string) (*float64, events.ObservationKind) {
		if !ok || m == nil {
			return nil, events.ObservationUnavailable
		}
		v, exists := m[key]
		if !exists {
			return nil, events.ObservationUnavailable
		}
		val := math.Round(v*100) / 100
		return &val, events.ObservationAggregate
	}

	readyVal, readyKind := lookup(eppMap, eppOK, "llm_d_epp_ready_endpoints")
	reqVal, reqKind := lookup(eppMap, eppOK, "llm_d_epp_request_total")
	kvHitsVal, kvHitsKind := lookup(eppMap, eppOK, "llm_d_epp_kv_cache_index_lookup_hits_total")
	fcQueueVal, fcQueueKind := lookup(eppMap, eppOK, "llm_d_epp_flow_control_queue_size")
	vllmRunVal, vllmRunKind := lookup(vllmMap, vllmOK, "vllm:num_requests_running")
	vllmWaitVal, vllmWaitKind := lookup(vllmMap, vllmOK, "vllm:num_requests_waiting")

	return []MetricSeries{
		{
			Name:            "llm_d_epp_ready_endpoints",
			Label:           "EPP Ready Model Endpoints",
			Category:        "epp",
			Value:           readyVal,
			Unit:            "pods",
			ObservationKind: readyKind,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "Number of ready vLLM pods registered in the InferencePool.",
		},
		{
			Name:            "llm_d_epp_request_total",
			Label:           "EPP Total Routed Requests",
			Category:        "epp",
			Value:           reqVal,
			Unit:            "requests",
			ObservationKind: reqKind,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "Aggregate requests processed by the llm-d Endpoint Picker.",
		},
		{
			Name:            "llm_d_epp_kv_cache_index_lookup_hits_total",
			Label:           "EPP KV-Cache Index Block Hits",
			Category:        "epp",
			Value:           kvHitsVal,
			Unit:            "blocks",
			ObservationKind: kvHitsKind,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "Aggregate 64-token KV block lookup hits in the EPP prefix cache indexer.",
		},
		{
			Name:            "llm_d_epp_flow_control_queue_size",
			Label:           "EPP Flow-Control Queue Depth",
			Category:        "epp",
			Value:           fcQueueVal,
			Unit:            "requests",
			ObservationKind: fcQueueKind,
			Source:          "llm-d-router-epp (:9090/metrics)",
			Explanation:     "System-wide gauge of requests buffered in EPP priority-band queues.",
		},
		{
			Name:            "vllm:num_requests_running",
			Label:           "vLLM Active Running Requests",
			Category:        "vllm",
			Value:           vllmRunVal,
			Unit:            "requests",
			ObservationKind: vllmRunKind,
			Source:          "vllm-model-server (:8000/metrics)",
			Explanation:     "Aggregate gauge of requests executing in the vLLM CPU scheduler.",
		},
		{
			Name:            "vllm:num_requests_waiting",
			Label:           "vLLM Scheduler Waiting Queue",
			Category:        "vllm",
			Value:           vllmWaitVal,
			Unit:            "requests",
			ObservationKind: vllmWaitKind,
			Source:          "vllm-model-server (:8000/metrics)",
			Explanation:     "Aggregate gauge of requests waiting in the vLLM internal scheduler queue.",
		},
	}
}

func appendBounded(slice []float64, val float64, max int) []float64 {
	if len(slice) >= max {
		slice = slice[1:]
	}
	return append(slice, math.Round(val*100)/100)
}

func percentile(samples []float64, p float64) *float64 {
	if len(samples) == 0 {
		return nil
	}
	sorted := make([]float64, len(samples))
	copy(sorted, samples)
	sort.Float64s(sorted)
	idx := int(math.Ceil(p*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	v := math.Round(sorted[idx]*100) / 100
	return &v
}

func meanSlice(samples []float64) *float64 {
	if len(samples) == 0 {
		return nil
	}
	var sum float64
	for _, s := range samples {
		sum += s
	}
	v := math.Round((sum/float64(len(samples)))*100) / 100
	return &v
}

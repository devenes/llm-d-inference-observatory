package telemetry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
)

func TestW3CTraceContextPropagationAndJaegerFetch(t *testing.T) {
	jaegerMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [{
				"traceID": "0af7651916cd43dd8448eb211c80319c",
				"processes": {
					"p1": {"serviceName": "llm-d-router/epp"},
					"p2": {"serviceName": "vllm-cpu-model-server"}
				},
				"spans": [
					{
						"traceID": "0af7651916cd43dd8448eb211c80319c",
						"spanID": "b7ad6b7169203331",
						"operationName": "epp.schedule",
						"startTime": 1730000000000000,
						"duration": 12000,
						"processID": "p1",
						"tags": [
							{"key": "selected_endpoint", "value": "10.20.0.14:8000"},
							{"key": "prompt", "value": "secret user prompt"}
						]
					},
					{
						"traceID": "0af7651916cd43dd8448eb211c80319c",
						"spanID": "c8ad6b7169203332",
						"operationName": "vllm.llm_request",
						"startTime": 1730000000015000,
						"duration": 180000,
						"processID": "p2",
						"references": [{"refType": "CHILD_OF", "spanID": "b7ad6b7169203331"}],
						"tags": [{"key": "model", "value": "Qwen/Qwen2.5-0.5B-Instruct"}]
					}
				]
			}]
		}`))
	}))
	defer jaegerMock.Close()

	cfg := config.Default()
	cfg.JaegerQueryURL = jaegerMock.URL
	cfg.RedactPrompts = true

	tm, err := NewTracerManager(context.Background(), cfg)
	if err != nil {
		t.Fatalf("failed to create TracerManager: %v", err)
	}
	defer func() { _ = tm.Shutdown(context.Background()) }()

	ctx, span, traceID, spanID := tm.StartRequestSpan(context.Background(), "req_abc", cfg.DefaultModel, cfg.RouterMode, true)
	defer span.End()
	if len(traceID) != 32 || len(spanID) != 16 {
		t.Fatalf("unexpected traceID/spanID lengths: %s / %s", traceID, spanID)
	}

	hdr := make(http.Header)
	tm.InjectHeaders(ctx, hdr)
	tp := hdr.Get("traceparent")
	if !strings.Contains(tp, traceID) {
		t.Fatalf("expected W3C traceparent header to contain %s, got %q", traceID, tp)
	}

	spans, err := tm.FetchJaegerTrace(context.Background(), "0af7651916cd43dd8448eb211c80319c")
	if err != nil {
		t.Fatalf("FetchJaegerTrace failed: %v", err)
	}
	if len(spans) != 2 {
		t.Fatalf("expected 2 spans, got %d", len(spans))
	}
	if spans[0].Attributes["prompt"] != "[REDACTED]" {
		t.Fatalf("expected sensitive prompt attribute in Jaeger span to be redacted, got %v", spans[0].Attributes["prompt"])
	}
	if spans[0].ObservationKind != events.ObservationObserved {
		t.Fatalf("expected Jaeger span observation_kind to be observed, got %s", spans[0].ObservationKind)
	}
}

func TestMetricsClassificationAndPrometheusScraping(t *testing.T) {
	eppSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Join([]string{
			"# HELP llm_d_epp_ready_endpoints Ready endpoints",
			"# TYPE llm_d_epp_ready_endpoints gauge",
			"llm_d_epp_ready_endpoints 2",
			"llm_d_epp_request_total 29",
			"llm_d_epp_request_error_total{error_code=\"ModelServerError\"} 4",
			"llm_d_epp_request_error_total{error_code=\"ServiceUnavailable\"} 1",
			"llm_d_epp_flow_control_pool_saturation{inference_pool=\"llm-d-router\",stage=\"decode\"} 0.5",
			"llm_d_epp_flow_control_pool_saturation{inference_pool=\"llm-d-router\",stage=\"effective\"} 0.5",
			"llm_d_epp_kv_cache_index_admissions_total 36",
		}, "\n") + "\n"))
	}))
	defer eppSrv.Close()

	vllmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("vllm:num_requests_running 2\nvllm:num_requests_waiting 0\nvllm:prefix_cache_queries_total 0\nvllm:prefix_cache_hits_total 0\n"))
	}))
	defer vllmSrv.Close()

	cfg := config.Default()
	cfg.MockMode = false
	cfg.EPPMetricsURL = eppSrv.URL
	cfg.VLLMMetricsURL = vllmSrv.URL

	mc := NewMetricsCollector(cfg)
	mc.IncInFlight()
	ttft := 619.6
	itl := 24.6
	dur := 1093.3
	tps := 40.48
	mc.RecordCompletion("completed", &ttft, &itl, &dur, &tps, 28, 20)
	mc.IncInFlight()
	mc.RecordFailure(true) // Routed ModelServerError (e.g. HTTP 404)
	mc.IncInFlight()
	mc.RecordFailure(false) // Pre-routing rejection (e.g. HTTP 503 ServiceUnavailable)

	summary := mc.GetSummary(context.Background())
	if summary.ObservationScope != events.ObservationAggregate {
		t.Fatalf("expected aggregate scope in non-mock mode, got %s", summary.ObservationScope)
	}
	if summary.EPPScrapeStatus != "scraped" || summary.VLLMScrapeStatus != "scraped" {
		t.Fatalf("expected both endpoints to be scraped, got epp=%s vllm=%s", summary.EPPScrapeStatus, summary.VLLMScrapeStatus)
	}

	byName := make(map[string]MetricSeries, len(summary.Series))
	for _, s := range summary.Series {
		byName[s.Name] = s
	}

	// 1. Verify stage="effective" filtering on llm_d_epp_flow_control_pool_saturation (0.5, not 1.0)
	sat := byName["llm_d_epp_flow_control_pool_saturation"]
	if sat.ObservationKind != events.ObservationAggregate || sat.Value == nil || *sat.Value != 0.5 {
		t.Fatalf("expected llm_d_epp_flow_control_pool_saturation=0.5 (stage=effective), got %+v", sat)
	}

	// 2. Verify genuine 0 value for llm_d_epp_flow_control_queue_size when flowControl subsystem is active
	qSize := byName["llm_d_epp_flow_control_queue_size"]
	if qSize.ObservationKind != events.ObservationAggregate || qSize.Value == nil || *qSize.Value != 0 {
		t.Fatalf("expected genuine 0 for llm_d_epp_flow_control_queue_size when flowControl is active, got %+v", qSize)
	}

	// 3. Verify genuine 0 value for llm_d_epp_kv_cache_index_lookup_hits_total when KV indexer is active
	kvHits := byName["llm_d_epp_kv_cache_index_lookup_hits_total"]
	if kvHits.ObservationKind != events.ObservationAggregate || kvHits.Value == nil || *kvHits.Value != 0 {
		t.Fatalf("expected genuine 0 for llm_d_epp_kv_cache_index_lookup_hits_total when KV indexer is active, got %+v", kvHits)
	}

	// 4. Verify request counter breakdown (pre-routing rejection vs routed upstream error)
	preRej := byName["observer_requests_rejected_prerouting_total"]
	upErr := byName["observer_requests_upstream_error_total"]
	eppErr := byName["llm_d_epp_request_error_total"]
	if preRej.Value == nil || *preRej.Value != 1 || upErr.Value == nil || *upErr.Value != 1 {
		t.Fatalf("expected 1 prerouting rejection and 1 routed upstream error, got pre=%+v up=%+v", preRej, upErr)
	}
	if eppErr.Value == nil || *eppErr.Value != 5 {
		t.Fatalf("expected llm_d_epp_request_error_total=5, got %+v", eppErr)
	}

	promText := mc.RenderPrometheus()
	if !strings.Contains(promText, `observer_requests_total{status="completed"} 1`) {
		t.Fatalf("expected completed counter in prometheus output, got:\n%s", promText)
	}
	if !strings.Contains(promText, `observer_requests_failed_by_scope_total{scope="prerouting_rejected"} 1`) ||
		!strings.Contains(promText, `observer_requests_failed_by_scope_total{scope="routed_upstream_error"} 1`) {
		t.Fatalf("expected failure scope counters in prometheus output, got:\n%s", promText)
	}
}

func TestMissingMetricsRemainUnavailableWhenSubsystemsDisabled(t *testing.T) {
	eppSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only core endpoint gauge exposed; flowControl and precise-prefix-cache-producer disabled
		_, _ = w.Write([]byte("llm_d_epp_ready_endpoints 2\n"))
	}))
	defer eppSrv.Close()

	cfg := config.Default()
	cfg.MockMode = false
	cfg.EPPMetricsURL = eppSrv.URL
	cfg.VLLMMetricsURL = "http://127.0.0.1:1/unreachable"

	mc := NewMetricsCollector(cfg)
	summary := mc.GetSummary(context.Background())

	byName := make(map[string]MetricSeries, len(summary.Series))
	for _, s := range summary.Series {
		byName[s.Name] = s
	}

	for _, disabledMetric := range []string{
		"llm_d_epp_flow_control_queue_size",
		"llm_d_epp_flow_control_pool_saturation",
		"llm_d_epp_kv_cache_index_lookup_hits_total",
	} {
		ms := byName[disabledMetric]
		if ms.ObservationKind != events.ObservationUnavailable || ms.Value != nil {
			t.Fatalf("expected %s to be unavailable when subsystem is disabled, got %+v", disabledMetric, ms)
		}
	}
}

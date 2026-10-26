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
		_, _ = w.Write([]byte("llm_d_epp_ready_endpoints 2\nllm_d_epp_request_total 15\nllm_d_epp_flow_control_queue_size 1\n"))
	}))
	defer eppSrv.Close()

	vllmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("vllm:num_requests_running 2\nvllm:num_requests_waiting 0\n"))
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

	summary := mc.GetSummary(context.Background())
	if summary.ObservationScope != events.ObservationAggregate {
		t.Fatalf("expected aggregate scope in non-mock mode, got %s", summary.ObservationScope)
	}
	if summary.EPPScrapeStatus != "scraped" || summary.VLLMScrapeStatus != "scraped" {
		t.Fatalf("expected both endpoints to be scraped, got epp=%s vllm=%s", summary.EPPScrapeStatus, summary.VLLMScrapeStatus)
	}

	promText := mc.RenderPrometheus()
	if !strings.Contains(promText, `observer_requests_total{status="completed"} 1`) {
		t.Fatalf("expected completed counter in prometheus output, got:\n%s", promText)
	}
}

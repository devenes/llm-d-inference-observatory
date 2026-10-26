package mock

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/redact"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/telemetry"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/upstream"
)

// Simulator executes deterministic local demo scenarios when OBSERVER_MOCK_MODE=true.
// Every emitted event, timing, and span is explicitly labeled with ObservationSimulated.
type Simulator struct {
	cfg     config.Config
	hub     *events.Hub
	metrics *telemetry.MetricsCollector
}

// NewSimulator constructs a local mock simulator.
func NewSimulator(cfg config.Config, hub *events.Hub, metrics *telemetry.MetricsCollector) *Simulator {
	return &Simulator{
		cfg:     cfg,
		hub:     hub,
		metrics: metrics,
	}
}

// Execute runs the requested mock scenario and streams or writes a deterministic OpenAI-compatible response.
func (s *Simulator) Execute(ctx context.Context, reqID, traceID string, startTime time.Time, inferReq upstream.InferRequest, w http.ResponseWriter, streamToClient bool) {
	scenario := strings.ToLower(strings.TrimSpace(inferReq.Scenario))
	if scenario == "" {
		scenario = "success"
	}

	// Toggle missing_metrics simulation on the collector when requested.
	s.metrics.SetForceMissing(scenario == "missing_metrics")

	routerMode := inferReq.RouterMode
	if routerMode == "" {
		routerMode = s.cfg.RouterMode
	}
	priorityBand := inferReq.PriorityBand
	if priorityBand == "" {
		priorityBand = "standard-traffic"
	}

	// Stage 1: Gateway/Proxy forwarding
	if !sleepContext(ctx, 8*time.Millisecond) {
		s.cancelSimulated(reqID, startTime, 0, 0, nil)
		return
	}
	fwdDurNs := time.Since(startTime).Nanoseconds()
	s.hub.Emit(reqID, events.EventGatewayForwarded, "mock-envoy-proxy", "gateway-proxy",
		"[SIMULATED] Envoy sidecar (:8081) received request and invoked EPP ext_proc (:9002)",
		events.ObservationSimulated, &fwdDurNs, map[string]any{
			"simulated":     true,
			"router_mode":   routerMode,
			"priority_band": priorityBand,
			"listener_port": 8081,
			"ext_proc_port": 9002,
		})

	// Stage 2: Optional Queueing / Admission Control (when flow-control or failed/saturated scenario)
	if routerMode == "flow-control" || scenario == "failed" || scenario == "upstream_error" || scenario == "saturated" {
		if !sleepContext(ctx, 12*time.Millisecond) {
			s.cancelSimulated(reqID, startTime, 0, 0, nil)
			return
		}
		qDur := int64(12 * time.Millisecond)
		if scenario == "failed" || scenario == "upstream_error" || scenario == "saturated" {
			s.hub.Emit(reqID, events.EventQueueObserved, "mock-epp", "epp",
				"[SIMULATED] EPP flow-control concurrency detector rejected request (x-llm-d-request-dropped-reason: rejected-saturated)",
				events.ObservationSimulated, &qDur, map[string]any{
					"simulated":       true,
					"priority_band":   priorityBand,
					"dropped_reason":  "rejected-saturated",
					"pool_saturation": 1.0,
					"http_status":     http.StatusTooManyRequests,
				})
			s.failSimulated(reqID, startTime, http.StatusTooManyRequests,
				"[SIMULATED] HTTP 429 Too Many Requests: InferencePool saturated (x-llm-d-request-dropped-reason: rejected-saturated)",
				w, streamToClient)
			return
		}

		s.hub.Emit(reqID, events.EventQueueObserved, "mock-epp", "epp",
			fmt.Sprintf("[SIMULATED] Admitted via EPP flow-control priority band %s (FCFS ordering, round-robin fairness)", priorityBand),
			events.ObservationSimulated, &qDur, map[string]any{
				"simulated":     true,
				"priority_band": priorityBand,
				"queue_policy":  "fcfs-ordering-policy",
			})
	}

	// Stage 3: EPP Routing & Scoring
	if !sleepContext(ctx, 10*time.Millisecond) {
		s.cancelSimulated(reqID, startTime, 0, 0, nil)
		return
	}
	routeDur := int64(10 * time.Millisecond)
	s.hub.Emit(reqID, events.EventRoutingStarted, "mock-epp", "epp",
		fmt.Sprintf("[SIMULATED] EPP scheduling profile (%s) filtering and scoring 2 ready CPU endpoints", routerMode),
		events.ObservationSimulated, &routeDur, map[string]any{
			"simulated":               true,
			"router_mode":             routerMode,
			"peak_prefill_throughput": 350,
			"candidate_endpoints":     2,
		})

	selectedEndpoint := "10.20.0.14:8000 (experimental-small-vllm-decode-0)"
	s.hub.Emit(reqID, events.EventEndpointSelected, "mock-epp", "inference-pool",
		fmt.Sprintf("[SIMULATED] EPP selected %s via prefix-cache-affinity-filter + token-load-scorer", selectedEndpoint),
		events.ObservationSimulated, &routeDur, map[string]any{
			"simulated":                      true,
			"selected_endpoint":              selectedEndpoint,
			"x_gateway_destination_endpoint": "10.20.0.14:8000",
			"prefix_cache_affinity_score":    0.88,
			"token_load_score":               0.92,
		})

	// Stage 4: Model Server Request Arrival & Prefill Delay
	prefillWait := 25 * time.Millisecond
	if scenario == "delay" {
		prefillWait = 180 * time.Millisecond
	}
	if !sleepContext(ctx, prefillWait) {
		s.cancelSimulated(reqID, startTime, 0, 0, nil)
		return
	}

	headersDur := time.Since(startTime)
	headersNs := headersDur.Nanoseconds()
	s.hub.Emit(reqID, events.EventModelRequestStarted, "mock-vllm-cpu", "model-server",
		fmt.Sprintf("[SIMULATED] vLLM CPU model server (%s) accepted request and started prompt processing", inferReq.Model),
		events.ObservationSimulated, &headersNs, map[string]any{
			"simulated":          true,
			"model":              inferReq.Model,
			"endpoint":           selectedEndpoint,
			"headers_latency_ms": float64(headersNs) / 1e6,
		})

	promptTokens := redact.EstimateTokens(inferReq.ExtractPromptText())
	tokens := buildSimulatedTokens(inferReq.Model, routerMode, scenario, inferReq.MaxTokens)

	tokenInterval := 14 * time.Millisecond
	if scenario == "delay" || scenario == "cancel" {
		tokenInterval = 45 * time.Millisecond
	}

	if inferReq.Stream {
		s.streamTokens(ctx, reqID, traceID, startTime, headersDur, selectedEndpoint, scenario, inferReq.Model, promptTokens, tokens, tokenInterval, w, streamToClient)
	} else {
		s.writeNonStreamResponse(ctx, reqID, traceID, startTime, headersDur, selectedEndpoint, scenario, inferReq.Model, promptTokens, tokens, tokenInterval, w)
	}
}

func (s *Simulator) streamTokens(ctx context.Context, reqID, traceID string, startTime time.Time, headersDur time.Duration, selectedEndpoint, scenario, model string, promptTokens int, tokens []string, tokenInterval time.Duration, w http.ResponseWriter, streamToClient bool) {
	var flusher http.Flusher
	if streamToClient && w != nil {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.Header().Set("X-Request-Id", reqID)
		w.Header().Set("X-Simulated-Mode", "true")
		w.WriteHeader(http.StatusOK)
		flusher, _ = w.(http.Flusher)
		if flusher != nil {
			flusher.Flush()
		}

		// Emit an initial OpenAI role-only chunk (content: "") to verify True TTFT ignores empty role chunks.
		roleChunk, _ := json.Marshal(map[string]any{
			"id":      "chatcmpl-" + reqID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   model,
			"choices": []map[string]any{
				{
					"index": 0,
					"delta": map[string]any{"role": "assistant", "content": ""},
				},
			},
		})
		_, _ = fmt.Fprintf(w, "data: %s\n\n", string(roleChunk))
		if flusher != nil {
			flusher.Flush()
		}
	}

	var (
		ttftDur       *time.Duration
		lastTokenTime time.Time
		itlSamplesMs  []float64
		emittedTokens int
	)

	for i, tok := range tokens {
		if !sleepContext(ctx, tokenInterval) {
			s.cancelSimulated(reqID, startTime, promptTokens, emittedTokens, ttftDur)
			return
		}
		now := time.Now()
		emittedTokens++

		if ttftDur == nil {
			d := now.Sub(startTime)
			ttftDur = &d
			ttftNs := d.Nanoseconds()
			lastTokenTime = now
			s.hub.Emit(reqID, events.EventModelFirstToken, "mock-vllm-cpu", "model-server",
				fmt.Sprintf("[SIMULATED] First non-empty generated token arrived (True TTFT %.2f ms)", float64(ttftNs)/1e6),
				events.ObservationSimulated, &ttftNs, map[string]any{
					"simulated":          true,
					"ttft_ms":            float64(ttftNs) / 1e6,
					"headers_to_ttft_ms": float64((d - headersDur).Nanoseconds()) / 1e6,
					"token_index":        1,
				})
		} else {
			itl := now.Sub(lastTokenTime)
			lastTokenTime = now
			itlMs := float64(itl.Nanoseconds()) / 1e6
			itlSamplesMs = append(itlSamplesMs, itlMs)
			itlNs := itl.Nanoseconds()
			s.hub.Emit(reqID, events.EventModelToken, "mock-vllm-cpu", "model-server",
				fmt.Sprintf("[SIMULATED] Streamed token #%d (ITL %.2f ms)", i+1, itlMs),
				events.ObservationSimulated, &itlNs, map[string]any{
					"simulated":   true,
					"token_index": i + 1,
					"itl_ms":      itlMs,
				})
		}

		if streamToClient && w != nil {
			var finishReason any
			if i == len(tokens)-1 {
				finishReason = "stop"
			}
			chunk, _ := json.Marshal(map[string]any{
				"id":      "chatcmpl-" + reqID,
				"object":  "chat.completion.chunk",
				"created": time.Now().Unix(),
				"model":   model,
				"choices": []map[string]any{
					{
						"index":         0,
						"delta":         map[string]any{"content": tok},
						"finish_reason": finishReason,
					},
				},
			})
			_, _ = fmt.Fprintf(w, "data: %s\n\n", string(chunk))
			if flusher != nil {
				flusher.Flush()
			}
		}
	}

	if streamToClient && w != nil {
		_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}

	streamDoneNs := time.Since(startTime).Nanoseconds()
	s.hub.Emit(reqID, events.EventModelStreamCompleted, "mock-vllm-cpu", "model-server",
		fmt.Sprintf("[SIMULATED] Completed SSE token stream (%d tokens)", emittedTokens),
		events.ObservationSimulated, &streamDoneNs, map[string]any{
			"simulated":         true,
			"completion_tokens": emittedTokens,
		})

	s.completeSimulated(reqID, traceID, startTime, headersDur, ttftDur, itlSamplesMs, promptTokens, emittedTokens, selectedEndpoint, scenario)
}

func (s *Simulator) writeNonStreamResponse(ctx context.Context, reqID, traceID string, startTime time.Time, headersDur time.Duration, selectedEndpoint, scenario, model string, promptTokens int, tokens []string, tokenInterval time.Duration, w http.ResponseWriter) {
	wait := time.Duration(len(tokens)) * (tokenInterval / 2)
	if wait > 200*time.Millisecond {
		wait = 200 * time.Millisecond
	}
	if !sleepContext(ctx, wait) {
		s.cancelSimulated(reqID, startTime, promptTokens, 0, nil)
		return
	}

	fullText := strings.Join(tokens, "")
	s.completeSimulated(reqID, traceID, startTime, headersDur, nil, nil, promptTokens, len(tokens), selectedEndpoint, scenario)

	if w != nil {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", reqID)
		w.Header().Set("X-Simulated-Mode", "true")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":      "chatcmpl-" + reqID,
			"object":  "chat.completion",
			"created": time.Now().Unix(),
			"model":   model,
			"choices": []map[string]any{
				{
					"index": 0,
					"message": map[string]any{
						"role":    "assistant",
						"content": fullText,
					},
					"finish_reason": "stop",
				},
			},
			"usage": map[string]any{
				"prompt_tokens":     promptTokens,
				"completion_tokens": len(tokens),
				"total_tokens":      promptTokens + len(tokens),
			},
		})
	}
}

func (s *Simulator) completeSimulated(reqID, traceID string, startTime time.Time, headersDur time.Duration, ttftDur *time.Duration, itlSamplesMs []float64, promptTokens, completionTokens int, selectedEndpoint, scenario string) {
	totalDur := time.Since(startTime)
	totalNs := totalDur.Nanoseconds()
	now := time.Now().UTC()

	var prefillSpanMs *float64
	if scenario != "partial_trace" {
		p := float64(headersDur.Nanoseconds()) / 1e6 * 0.65
		prefillSpanMs = &p
	}

	s.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
		rec.Status = "completed"
		rec.HTTPStatus = http.StatusOK
		rec.SelectedEndpoint = selectedEndpoint
		rec.CompletedAt = &now
		events.FinalizeTimings(rec, &headersDur, ttftDur, &totalDur, itlSamplesMs, promptTokens, completionTokens, prefillSpanMs)
	})

	s.hub.Emit(reqID, events.EventRequestCompleted, "observer-api", "observer-api",
		fmt.Sprintf("[SIMULATED] Request completed (%d output tokens in %.2f ms)", completionTokens, float64(totalNs)/1e6),
		events.ObservationSimulated, &totalNs, map[string]any{
			"simulated":         true,
			"prompt_tokens":     promptTokens,
			"completion_tokens": completionTokens,
			"total_duration_ms": float64(totalNs) / 1e6,
		})

	if rec, ok := s.hub.GetRequest(reqID); ok {
		s.metrics.RecordCompletion("completed", rec.Timings.TTFTMs.Value, rec.Timings.MeanITLMs.Value, rec.Timings.TotalDurationMs.Value, rec.Timings.DecodeTokensPerSec.Value, promptTokens, completionTokens)
	}

	if scenario == "delayed_trace" {
		go func() {
			time.Sleep(350 * time.Millisecond)
			s.populateSimulatedTrace(reqID, traceID, startTime, totalDur, selectedEndpoint, false)
		}()
	} else {
		s.populateSimulatedTrace(reqID, traceID, startTime, totalDur, selectedEndpoint, scenario == "partial_trace")
	}
}

func (s *Simulator) populateSimulatedTrace(reqID, traceID string, startTime time.Time, totalDur time.Duration, selectedEndpoint string, partial bool) {
	rootSpanID := "a1b2c3d4e5f60001"
	envoySpanID := "a1b2c3d4e5f60002"
	eppSpanID := "a1b2c3d4e5f60003"
	vllmSpanID := "a1b2c3d4e5f60004"

	t0 := startTime.UTC()
	tEnvoyStart := t0.Add(2 * time.Millisecond)
	tEppStart := t0.Add(4 * time.Millisecond)
	tEppEnd := t0.Add(16 * time.Millisecond)
	tVllmStart := t0.Add(18 * time.Millisecond)
	tEnd := t0.Add(totalDur)

	spans := []events.SpanNode{
		{
			SpanID:          rootSpanID,
			TraceID:         traceID,
			OperationName:   "POST /api/infer/stream",
			ServiceName:     "observer-api",
			Component:       "observer-api",
			StartTime:       t0.Format(time.RFC3339Nano),
			EndTime:         tEnd.Format(time.RFC3339Nano),
			DurationNs:      totalDur.Nanoseconds(),
			ObservationKind: events.ObservationSimulated,
			Status:          "ok",
			Attributes: map[string]any{
				"simulated":        true,
				"llm_d.request_id": reqID,
			},
		},
		{
			SpanID:          envoySpanID,
			ParentSpanID:    rootSpanID,
			TraceID:         traceID,
			OperationName:   "envoy.http_connection_manager.vllm",
			ServiceName:     "llm-d-router-envoy",
			Component:       "gateway-proxy",
			StartTime:       tEnvoyStart.Format(time.RFC3339Nano),
			EndTime:         tEnd.Add(-1 * time.Millisecond).Format(time.RFC3339Nano),
			DurationNs:      (totalDur - 3*time.Millisecond).Nanoseconds(),
			ObservationKind: events.ObservationSimulated,
			Status:          "ok",
			Attributes: map[string]any{
				"simulated":                      true,
				"x_gateway_destination_endpoint": selectedEndpoint,
			},
		},
		{
			SpanID:          eppSpanID,
			ParentSpanID:    envoySpanID,
			TraceID:         traceID,
			OperationName:   "epp.ext_proc.schedule",
			ServiceName:     "llm-d-router/epp",
			Component:       "epp",
			StartTime:       tEppStart.Format(time.RFC3339Nano),
			EndTime:         tEppEnd.Format(time.RFC3339Nano),
			DurationNs:      (12 * time.Millisecond).Nanoseconds(),
			ObservationKind: events.ObservationSimulated,
			Status:          "ok",
			Attributes: map[string]any{
				"simulated":         true,
				"selected_endpoint": selectedEndpoint,
				"plugins":           "prefix-cache-affinity-filter,token-load-scorer",
			},
		},
	}

	traceStatus := "enriched"
	errMsg := ""
	if partial {
		traceStatus = "partial"
		errMsg = "Partial trace: vLLM model-server spans were not exported (simulated partial instrumentation)"
	} else {
		vllmDur := totalDur - 20*time.Millisecond
		if vllmDur < 5*time.Millisecond {
			vllmDur = 5 * time.Millisecond
		}
		spans = append(spans, events.SpanNode{
			SpanID:          vllmSpanID,
			ParentSpanID:    envoySpanID,
			TraceID:         traceID,
			OperationName:   "vllm.llm_request",
			ServiceName:     "vllm-cpu-model-server",
			Component:       "model-server",
			StartTime:       tVllmStart.Format(time.RFC3339Nano),
			EndTime:         tVllmStart.Add(vllmDur).Format(time.RFC3339Nano),
			DurationNs:      vllmDur.Nanoseconds(),
			ObservationKind: events.ObservationSimulated,
			Status:          "ok",
			Attributes: map[string]any{
				"simulated": true,
				"endpoint":  selectedEndpoint,
				"engine":    "vllm-openai-cpu:v0.31.0",
			},
		})
	}

	nowStr := time.Now().UTC().Format(time.RFC3339Nano)
	s.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
		rec.Trace.Status = traceStatus
		rec.Trace.ObservationKind = events.ObservationSimulated
		rec.Trace.EnrichedAt = nowStr
		rec.Trace.ErrorMessage = errMsg
		rec.Trace.Spans = spans
	})

	durNs := totalDur.Nanoseconds()
	s.hub.Emit(reqID, events.EventTraceEnriched, "mock-jaeger", "otel-collector",
		fmt.Sprintf("[SIMULATED] Trace enrichment complete (%s, %d spans)", traceStatus, len(spans)),
		events.ObservationSimulated, &durNs, map[string]any{
			"simulated":    true,
			"trace_status": traceStatus,
			"span_count":   len(spans),
		})
}

func (s *Simulator) cancelSimulated(reqID string, startTime time.Time, promptTokens, completionTokens int, ttftDur *time.Duration) {
	totalDur := time.Since(startTime)
	totalNs := totalDur.Nanoseconds()
	now := time.Now().UTC()

	s.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
		rec.Status = "cancelled"
		rec.HTTPStatus = 499
		rec.CompletedAt = &now
		events.FinalizeTimings(rec, nil, ttftDur, &totalDur, nil, promptTokens, completionTokens, nil)
	})
	s.hub.Emit(reqID, events.EventRequestCancelled, "observer-api", "observer-api",
		"[SIMULATED] Client cancelled in-flight inference request; token generation aborted",
		events.ObservationSimulated, &totalNs, map[string]any{
			"simulated":            true,
			"tokens_before_cancel": completionTokens,
		})
	if rec, ok := s.hub.GetRequest(reqID); ok {
		s.metrics.RecordCompletion("cancelled", rec.Timings.TTFTMs.Value, nil, rec.Timings.TotalDurationMs.Value, nil, promptTokens, completionTokens)
	}
}

func (s *Simulator) failSimulated(reqID string, startTime time.Time, statusCode int, msg string, w http.ResponseWriter, streamToClient bool) {
	totalDur := time.Since(startTime)
	totalNs := totalDur.Nanoseconds()
	now := time.Now().UTC()

	s.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
		rec.Status = "failed"
		rec.HTTPStatus = statusCode
		rec.ErrorMessage = msg
		rec.CompletedAt = &now
		events.FinalizeTimings(rec, nil, nil, &totalDur, nil, 0, 0, nil)
	})

	s.hub.Emit(reqID, events.EventRequestFailed, "mock-epp", "epp",
		msg,
		events.ObservationSimulated, &totalNs, map[string]any{
			"simulated":   true,
			"http_status": statusCode,
		})
	s.metrics.RecordCompletion("failed", nil, nil, nil, nil, 0, 0)

	if w != nil {
		if streamToClient {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("X-Simulated-Mode", "true")
			w.WriteHeader(statusCode)
			errPayload, _ := json.Marshal(map[string]any{
				"error": map[string]any{
					"message":    msg,
					"type":       "simulated_upstream_error",
					"request_id": reqID,
				},
			})
			_, _ = fmt.Fprintf(w, "data: %s\n\n", string(errPayload))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Simulated-Mode", "true")
		w.WriteHeader(statusCode)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message":    msg,
				"type":       "simulated_upstream_error",
				"request_id": reqID,
			},
		})
	}
}

func buildSimulatedTokens(model, routerMode, scenario string, maxTokens int) []string {
	base := []string{
		"[SIMULATED ", "LOCAL ", "DEMO] ", "Request ", "routed ", "via ",
		"llm-d ", fmt.Sprintf("(%s) ", routerMode), "through ", "Envoy ", "ext_proc ",
		"to ", "EPP ", "and ", fmt.Sprintf("%s ", model), "on ", "CPU-only ", "GKE. ",
		"Every ", "event ", "in ", "this ", "run ", "is ", "explicitly ",
		"classified ", "as ", "simulated ", "(scenario=", scenario, ").",
	}
	if scenario == "cancel" {
		// Longer token list so client cancellation has ample time in-flight.
		for i := 0; i < 40; i++ {
			base = append(base, fmt.Sprintf(" token_%d", i+1))
		}
	}
	if maxTokens > 0 && maxTokens < len(base) {
		return base[:maxTokens]
	}
	return base
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return false
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

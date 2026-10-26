package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/mock"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/redact"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/telemetry"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/upstream"
	"github.com/google/uuid"
)

// Server exposes the Observer API HTTP endpoints.
type Server struct {
	cfg       config.Config
	logger    *slog.Logger
	hub       *events.Hub
	tracer    *telemetry.TracerManager
	metrics   *telemetry.MetricsCollector
	upstream  *upstream.Client
	simulator *mock.Simulator
	sem       chan struct{}
	mux       *http.ServeMux
}

// New constructs a configured Observer API Server.
func New(cfg config.Config, logger *slog.Logger, hub *events.Hub, tracer *telemetry.TracerManager, metrics *telemetry.MetricsCollector) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{
		cfg:       cfg,
		logger:    logger,
		hub:       hub,
		tracer:    tracer,
		metrics:   metrics,
		upstream:  upstream.NewClient(cfg, hub, tracer, metrics),
		simulator: mock.NewSimulator(cfg, hub, metrics),
		sem:       make(chan struct{}, cfg.MaxConcurrentReqs),
		mux:       http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

func (s *Server) registerRoutes() {
	s.mux.HandleFunc("POST /api/infer", s.handleInfer(false))
	s.mux.HandleFunc("POST /api/infer/stream", s.handleInfer(true))
	s.mux.HandleFunc("GET /api/requests", s.handleListRequests)
	s.mux.HandleFunc("GET /api/requests/{request_id}", s.handleGetRequest)
	s.mux.HandleFunc("GET /api/requests/{request_id}/events", s.handleGetRequestEvents)
	s.mux.HandleFunc("GET /api/requests/{request_id}/trace", s.handleGetRequestTrace)
	s.mux.HandleFunc("GET /api/metrics", s.handleGetMetrics)
	s.mux.HandleFunc("GET /metrics", s.handlePrometheusMetrics)
	s.mux.HandleFunc("GET /api/config", s.handleGetConfig)
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)
	s.mux.HandleFunc("GET /readyz", s.handleReadyz)
	s.mux.HandleFunc("GET /version", s.handleVersion)
}

// Handler returns the root http.Handler wrapped with CORS and security headers.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")

		origin := r.Header.Get("Origin")
		if origin != "" && s.isOriginAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept, X-Request-Id, traceparent, tracestate")
			w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id, X-Trace-Id, X-Simulated-Mode")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.mux.ServeHTTP(w, r)
	})
}

func (s *Server) isOriginAllowed(origin string) bool {
	for _, allowed := range s.cfg.CORSAllowedOrigins {
		if allowed == "*" || strings.EqualFold(allowed, origin) {
			return true
		}
	}
	return false
}

func (s *Server) handleInfer(forceStream bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Enforce concurrency limit
		select {
		case s.sem <- struct{}{}:
			defer func() { <-s.sem }()
		default:
			writeJSONError(w, http.StatusTooManyRequests, "concurrency_limit_exceeded",
				fmt.Sprintf("Observer API concurrency limit (%d) reached; please retry shortly", s.cfg.MaxConcurrentReqs), "")
			return
		}

		// Enforce request size limit
		r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxRequestBodyBytes)
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				writeJSONError(w, http.StatusRequestEntityTooLarge, "request_too_large",
					fmt.Sprintf("request body exceeds limit of %d bytes", s.cfg.MaxRequestBodyBytes), "")
				return
			}
			writeJSONError(w, http.StatusBadRequest, "invalid_request_body", "failed to read request body", "")
			return
		}

		var inferReq upstream.InferRequest
		if err := json.Unmarshal(bodyBytes, &inferReq); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON", "")
			return
		}

		// Never allow browser/client input to select an arbitrary upstream URL (SSRF protection)
		if strings.TrimSpace(inferReq.UpstreamURL) != "" {
			writeJSONError(w, http.StatusBadRequest, "upstream_override_forbidden",
				"client-supplied upstream_url is prohibited; upstream is strictly controlled by server allowlist", "")
			return
		}

		if forceStream {
			inferReq.Stream = true
		}

		if strings.TrimSpace(inferReq.Model) == "" {
			inferReq.Model = s.cfg.DefaultModel
		}
		if !s.cfg.IsModelAllowed(inferReq.Model) {
			writeJSONError(w, http.StatusBadRequest, "model_not_allowed",
				fmt.Sprintf("model %q is not in configured allowlist %v", inferReq.Model, s.cfg.AllowedModels), "")
			return
		}

		// Normalize prompt into messages if caller used prompt field
		if len(inferReq.Messages) == 0 && strings.TrimSpace(inferReq.Prompt) != "" {
			inferReq.Messages = []upstream.ChatMessage{
				{Role: "user", Content: inferReq.Prompt},
			}
		}
		if len(inferReq.Messages) == 0 || strings.TrimSpace(inferReq.ExtractPromptText()) == "" {
			writeJSONError(w, http.StatusBadRequest, "empty_prompt", "messages or prompt must contain non-empty text", "")
			return
		}

		if inferReq.MaxTokens <= 0 {
			inferReq.MaxTokens = 128
		}
		if inferReq.MaxTokens > s.cfg.MaxOutputTokens {
			writeJSONError(w, http.StatusBadRequest, "max_tokens_exceeded",
				fmt.Sprintf("max_tokens (%d) exceeds configured limit (%d)", inferReq.MaxTokens, s.cfg.MaxOutputTokens), "")
			return
		}

		if inferReq.RouterMode == "" {
			inferReq.RouterMode = s.cfg.RouterMode
		}
		if inferReq.PriorityBand == "" {
			inferReq.PriorityBand = "standard-traffic"
		}

		reqID := strings.TrimSpace(r.Header.Get("X-Request-Id"))
		if reqID == "" {
			reqID = "req_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16]
		}

		reqCtx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
		defer cancel()
		if s.tracer != nil {
			reqCtx = s.tracer.ExtractContext(reqCtx, r.Header)
		}

		var (
			traceID string
			spanEnd func()
		)
		if s.tracer != nil {
			var span interface{ End(...any) }
			_ = span
			cCtx, otelSpan, tID, _ := s.tracer.StartRequestSpan(reqCtx, reqID, inferReq.Model, inferReq.RouterMode, inferReq.Stream)
			reqCtx = cCtx
			traceID = tID
			spanEnd = func() { otelSpan.End() }
		} else {
			traceID = strings.ReplaceAll(uuid.NewString(), "-", "")
			spanEnd = func() {}
		}
		defer spanEnd()

		startTime := time.Now().UTC()
		promptMeta := redact.PromptSummary(inferReq.ExtractPromptText(), s.cfg.RedactPrompts)

		s.metrics.IncInFlight()
		s.hub.CreateRequest(reqID, traceID, inferReq.Model, inferReq.RouterMode, inferReq.PriorityBand, inferReq.Stream, s.cfg.MockMode, inferReq.Scenario, promptMeta, startTime)

		acceptKind := events.ObservationObserved
		acceptMsg := "Request accepted by Observer API; request_id and W3C trace context assigned"
		if s.cfg.MockMode {
			acceptKind = events.ObservationSimulated
			acceptMsg = "[SIMULATED] Request accepted by Observer API in local demo mode"
		}
		zeroNs := int64(0)
		s.hub.Emit(reqID, events.EventRequestAccepted, "observer-api", "observer-api", acceptMsg, acceptKind, &zeroNs, map[string]any{
			"model":         inferReq.Model,
			"router_mode":   inferReq.RouterMode,
			"priority_band": inferReq.PriorityBand,
			"stream":        inferReq.Stream,
			"max_tokens":    inferReq.MaxTokens,
			"mock_mode":     s.cfg.MockMode,
			"scenario":      inferReq.Scenario,
			"prompt_sha256": promptMeta["prompt_sha256_prefix"],
			"prompt_chars":  promptMeta["prompt_chars"],
		})

		s.logger.Info("accepted inference request",
			"request_id", reqID,
			"trace_id", traceID,
			"model", inferReq.Model,
			"router_mode", inferReq.RouterMode,
			"stream", inferReq.Stream,
			"mock_mode", s.cfg.MockMode,
			"prompt_summary", promptMeta["prompt_preview"],
		)

		w.Header().Set("X-Request-Id", reqID)
		w.Header().Set("X-Trace-Id", traceID)

		if s.cfg.MockMode {
			s.simulator.Execute(reqCtx, reqID, traceID, startTime, inferReq, w, inferReq.Stream)
			return
		}

		s.upstream.Forward(reqCtx, reqID, startTime, inferReq, w, inferReq.Stream)
		spanEnd()
		if s.tracer != nil {
			_ = s.tracer.ForceFlush(context.Background())
		}
	}
}

func (s *Server) handleListRequests(w http.ResponseWriter, r *http.Request) {
	list := s.hub.ListRequests(50)
	writeJSON(w, http.StatusOK, map[string]any{
		"mock_mode": s.cfg.MockMode,
		"count":     len(list),
		"requests":  list,
	})
}

func (s *Server) handleGetRequest(w http.ResponseWriter, r *http.Request) {
	reqID := r.PathValue("request_id")
	rec, ok := s.hub.GetRequest(reqID)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "request_not_found", fmt.Sprintf("request %q not found", reqID), reqID)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) handleGetRequestEvents(w http.ResponseWriter, r *http.Request) {
	reqID := r.PathValue("request_id")
	accept := r.Header.Get("Accept")
	wantSSE := strings.Contains(accept, "text/event-stream") || r.URL.Query().Get("stream") == "true"

	if !wantSSE {
		rec, ok := s.hub.GetRequest(reqID)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "request_not_found", fmt.Sprintf("request %q not found", reqID), reqID)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"request_id": rec.RequestID,
			"trace_id":   rec.TraceID,
			"status":     rec.Status,
			"mock_mode":  rec.MockMode,
			"events":     rec.Events,
		})
		return
	}

	snapshot, ch, unsub, ok := s.hub.Subscribe(reqID)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "request_not_found", fmt.Sprintf("request %q not found", reqID), reqID)
		return
	}
	defer unsub()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	sendEvent := func(env events.EventEnvelope) bool {
		b, err := json.Marshal(env)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", env.Sequence, env.EventType, string(b)); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	for _, ev := range snapshot {
		if !sendEvent(ev) {
			return
		}
	}

	// Check if request already reached terminal state and trace is not pending
	if rec, exists := s.hub.GetRequest(reqID); exists {
		if (rec.Status == "completed" || rec.Status == "failed" || rec.Status == "cancelled") && rec.Trace.Status != "pending" {
			return
		}
	}

	idleTimeout := time.NewTimer(15 * time.Second)
	defer idleTimeout.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-idleTimeout.C:
			return
		case ev, open := <-ch:
			if !open {
				return
			}
			if !sendEvent(ev) {
				return
			}
			if ev.EventType == events.EventTraceEnriched || ev.EventType == events.EventRequestCancelled || ev.EventType == events.EventRequestFailed {
				return
			}
		}
	}
}

func (s *Server) handleGetRequestTrace(w http.ResponseWriter, r *http.Request) {
	reqID := r.PathValue("request_id")
	rec, ok := s.hub.GetRequest(reqID)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "request_not_found", fmt.Sprintf("request %q not found", reqID), reqID)
		return
	}

	if !rec.MockMode && s.tracer != nil && rec.TraceID != "" && (rec.Trace.Status != "enriched" || len(rec.Trace.Spans) <= 1) {
		_ = s.tracer.ForceFlush(r.Context())
		spans, err := s.tracer.FetchJaegerTrace(r.Context(), rec.TraceID)
		if err == nil && len(spans) > 0 {
			nowStr := time.Now().UTC().Format(time.RFC3339Nano)
			ep := upstream.ExtractEndpointFromSpans(spans)
			s.hub.UpdateRequest(reqID, func(updated *events.RequestRecord) {
				updated.Trace.Status = "enriched"
				updated.Trace.ObservationKind = events.ObservationObserved
				updated.Trace.EnrichedAt = nowStr
				updated.Trace.ErrorMessage = ""
				updated.Trace.Spans = spans
				if ep != "" {
					updated.SelectedEndpoint = ep
				}
			})
			rec, _ = s.hub.GetRequest(reqID)
		}
	}

	writeJSON(w, http.StatusOK, rec.Trace)
}

func (s *Server) handleGetMetrics(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("format") == "prometheus" || strings.Contains(r.Header.Get("Accept"), "text/plain") {
		s.handlePrometheusMetrics(w, r)
		return
	}
	summary := s.metrics.GetSummary(r.Context())
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) handlePrometheusMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(s.metrics.RenderPrometheus()))
}

func (s *Server) handleGetConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":           config.Version,
		"mock_mode":         s.cfg.MockMode,
		"redact_prompts":    s.cfg.RedactPrompts,
		"allowed_models":    s.cfg.AllowedModels,
		"default_model":     s.cfg.DefaultModel,
		"router_mode":       s.cfg.RouterMode,
		"max_output_tokens": s.cfg.MaxOutputTokens,
		"cluster_name":      s.cfg.ClusterName,
		"namespace":         s.cfg.Namespace,
		"upstream_url":      s.cfg.UpstreamURL,
		"router_modes":      []string{"optimized-baseline", "precise-prefix-cache", "flow-control"},
		"priority_bands":    []string{"premium-traffic", "standard-traffic", "best-effort-traffic"},
		"mock_scenarios":    []string{"success", "delay", "saturated", "cancel", "partial_trace", "delayed_trace", "missing_metrics"},
	})
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (s *Server) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	if err := s.cfg.Validate(); err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "not_ready", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ready",
		"mock_mode": s.cfg.MockMode,
		"upstream":  s.cfg.UpstreamURL,
	})
}

func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"service":          "llm-d-inference-observatory-api",
		"version":          config.Version,
		"schema_version":   events.SchemaVersion,
		"llm_d_version":    "v1.0.0",
		"gaie_version":     "v1.6.2",
		"vllm_cpu_version": "v0.31.0",
		"mock_mode":        s.cfg.MockMode,
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeJSONError(w http.ResponseWriter, status int, code, message, reqID string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    message,
			"request_id": reqID,
		},
	})
}

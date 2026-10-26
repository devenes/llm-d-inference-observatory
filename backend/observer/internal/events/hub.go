package events

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/redact"
	"github.com/google/uuid"
)

// Hub manages bounded in-memory request records and per-request SSE event subscriptions.
type Hub struct {
	mu            sync.RWMutex
	maxRetained   int
	redactPrompts bool
	order         []string
	records       map[string]*RequestRecord
	subscribers   map[string]map[chan EventEnvelope]struct{}
}

// NewHub creates a bounded in-memory event hub.
func NewHub(maxRetained int, redactPrompts bool) *Hub {
	if maxRetained <= 0 {
		maxRetained = 200
	}
	return &Hub{
		maxRetained:   maxRetained,
		redactPrompts: redactPrompts,
		order:         make([]string, 0, maxRetained),
		records:       make(map[string]*RequestRecord, maxRetained),
		subscribers:   make(map[string]map[chan EventEnvelope]struct{}),
	}
}

// CreateRequest initializes and stores a new RequestRecord, evicting the oldest if capacity is reached.
func (h *Hub) CreateRequest(reqID, traceID, model, routerMode, priorityBand string, stream, mockMode bool, scenario string, promptMeta map[string]any, startTime time.Time) *RequestRecord {
	h.mu.Lock()
	defer h.mu.Unlock()

	if len(h.order) >= h.maxRetained {
		oldest := h.order[0]
		h.order = h.order[1:]
		delete(h.records, oldest)
		if subs, ok := h.subscribers[oldest]; ok {
			for ch := range subs {
				close(ch)
			}
			delete(h.subscribers, oldest)
		}
	}

	traceKind := ObservationObserved
	if mockMode {
		traceKind = ObservationSimulated
	}

	rec := &RequestRecord{
		RequestID:      reqID,
		TraceID:        traceID,
		Model:          model,
		RouterMode:     routerMode,
		PriorityBand:   priorityBand,
		Stream:         stream,
		MockMode:       mockMode,
		Scenario:       scenario,
		Status:         "in_flight",
		CreatedAt:      startTime,
		PromptMetadata: promptMeta,
		Timings: TimingBreakdown{
			RequestStartTimestamp: startTime.UTC().Format(time.RFC3339Nano),
			UpstreamHeadersMs: ClassifiedValue{
				Unit:            "ms",
				ObservationKind: ObservationUnavailable,
				Source:          "observer-api",
				Explanation:     "Time from request start until HTTP response headers arrive from upstream.",
			},
			TTFTMs: ClassifiedValue{
				Unit:            "ms",
				ObservationKind: ObservationUnavailable,
				Source:          "observer-api",
				Explanation:     "True Time To First Token: measured arrival of the first non-empty text token chunk at the Observer API.",
			},
			PrefillDurationMs: ClassifiedValue{
				Unit:            "ms",
				ObservationKind: ObservationUnavailable,
				Source:          "vllm-model-server",
				Explanation:     "Exact model-server prompt prefill duration. Never inferred from TTFT alone; requires an explicit model-server prefill span.",
			},
			TotalDurationMs: ClassifiedValue{
				Unit:            "ms",
				ObservationKind: ObservationUnavailable,
				Source:          "observer-api",
				Explanation:     "End-to-end request duration measured by the Observer API.",
			},
			MeanITLMs: ClassifiedValue{
				Unit:            "ms",
				ObservationKind: ObservationUnavailable,
				Source:          "observer-api",
				Explanation:     "Mean inter-token latency derived from consecutive streamed token arrival timestamps.",
			},
			P95ITLMs: ClassifiedValue{
				Unit:            "ms",
				ObservationKind: ObservationUnavailable,
				Source:          "observer-api",
				Explanation:     "95th percentile inter-token latency derived from streamed token arrival intervals.",
			},
			DecodeTokensPerSec: ClassifiedValue{
				Unit:            "tok/s",
				ObservationKind: ObservationUnavailable,
				Source:          "observer-api",
				Explanation:     "Decode throughput derived from post-first-token generation window.",
			},
			EndToEndTokensPerSec: ClassifiedValue{
				Unit:            "tok/s",
				ObservationKind: ObservationUnavailable,
				Source:          "observer-api",
				Explanation:     "End-to-end output token rate derived from total completion tokens divided by total request duration.",
			},
			ITLSamplesMs: []float64{},
		},
		Events: []EventEnvelope{},
		Trace: TraceRecord{
			RequestID:       reqID,
			TraceID:         traceID,
			Status:          "pending",
			ObservationKind: traceKind,
			Backend:         "jaeger-otlp",
			Spans:           []SpanNode{},
		},
		Topology: DefaultTopology(mockMode),
	}

	h.order = append(h.order, reqID)
	h.records[reqID] = rec
	return cloneRecord(rec)
}

// Emit appends a correlated lifecycle event to the request and notifies live SSE subscribers.
func (h *Hub) Emit(reqID string, eventType EventType, source, component, message string, obsKind ObservationKind, durationNs *int64, attrs map[string]any) (EventEnvelope, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	rec, ok := h.records[reqID]
	if !ok {
		return EventEnvelope{}, false
	}

	seq := len(rec.Events) + 1
	cleanAttrs := redact.SanitizeAttributes(attrs, h.redactPrompts)
	var durCopy *int64
	if durationNs != nil {
		v := *durationNs
		durCopy = &v
	}

	env := EventEnvelope{
		SchemaVersion:   SchemaVersion,
		RequestID:       reqID,
		TraceID:         rec.TraceID,
		EventID:         fmt.Sprintf("evt_%s_%03d", uuid.NewString()[:8], seq),
		Sequence:        seq,
		EventType:       eventType,
		Source:          source,
		SourceTimestamp: time.Now().UTC().Format(time.RFC3339Nano),
		ObservationKind: obsKind,
		Component:       component,
		Message:         redact.ScrubString(message),
		DurationNs:      durCopy,
		Attributes:      cleanAttrs,
	}

	rec.Events = append(rec.Events, env)
	rec.Topology = ComputeTopology(rec)

	if subs, exists := h.subscribers[reqID]; exists {
		for ch := range subs {
			select {
			case ch <- env:
			default:
			}
		}
	}

	return env, true
}

// UpdateRequest applies a mutation function to a stored RequestRecord under lock.
func (h *Hub) UpdateRequest(reqID string, fn func(rec *RequestRecord)) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	rec, ok := h.records[reqID]
	if !ok {
		return false
	}
	fn(rec)
	rec.Topology = ComputeTopology(rec)
	return true
}

// GetRequest returns a deep copy of a stored RequestRecord.
func (h *Hub) GetRequest(reqID string) (*RequestRecord, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	rec, ok := h.records[reqID]
	if !ok {
		return nil, false
	}
	return cloneRecord(rec), true
}

// ListRequests returns recent requests in reverse chronological order.
func (h *Hub) ListRequests(limit int) []*RequestRecord {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if limit <= 0 || limit > len(h.order) {
		limit = len(h.order)
	}
	out := make([]*RequestRecord, 0, limit)
	for i := len(h.order) - 1; i >= 0 && len(out) < limit; i-- {
		if rec, ok := h.records[h.order[i]]; ok {
			out = append(out, cloneRecord(rec))
		}
	}
	return out
}

// Subscribe returns a snapshot of existing events for reqID plus a live channel for subsequent events.
func (h *Hub) Subscribe(reqID string) ([]EventEnvelope, chan EventEnvelope, func(), bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	rec, ok := h.records[reqID]
	if !ok {
		return nil, nil, nil, false
	}

	snapshot := make([]EventEnvelope, len(rec.Events))
	copy(snapshot, rec.Events)

	ch := make(chan EventEnvelope, 128)
	if _, exists := h.subscribers[reqID]; !exists {
		h.subscribers[reqID] = make(map[chan EventEnvelope]struct{})
	}
	h.subscribers[reqID][ch] = struct{}{}

	var once sync.Once
	unsub := func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			if subs, exists := h.subscribers[reqID]; exists {
				if _, ok := subs[ch]; ok {
					delete(subs, ch)
					close(ch)
				}
			}
		})
	}

	return snapshot, ch, unsub, true
}

// FinalizeTimings populates measured and derived timing fields on the RequestRecord.
func FinalizeTimings(rec *RequestRecord, headersDur, ttftDur, totalDur *time.Duration, itlSamplesMs []float64, promptTokens, completionTokens int, prefillSpanMs *float64) {
	measuredKind := ObservationMeasured
	derivedKind := ObservationDerived
	observedKind := ObservationObserved
	if rec.MockMode {
		measuredKind = ObservationSimulated
		derivedKind = ObservationSimulated
		observedKind = ObservationSimulated
	}

	rec.Timings.PromptTokens = promptTokens
	rec.Timings.CompletionTokens = completionTokens

	if headersDur != nil {
		ms := roundMs(float64(headersDur.Nanoseconds()) / 1e6)
		rec.Timings.UpstreamHeadersMs.Value = &ms
		rec.Timings.UpstreamHeadersMs.ObservationKind = measuredKind
	}

	if ttftDur != nil {
		ms := roundMs(float64(ttftDur.Nanoseconds()) / 1e6)
		rec.Timings.TTFTMs.Value = &ms
		rec.Timings.TTFTMs.ObservationKind = measuredKind
	}

	// Never infer prefill duration from TTFT alone! Only set if a real/simulated prefill span was observed.
	if prefillSpanMs != nil {
		v := roundMs(*prefillSpanMs)
		rec.Timings.PrefillDurationMs.Value = &v
		rec.Timings.PrefillDurationMs.ObservationKind = observedKind
		rec.Timings.PrefillDurationMs.Explanation = "Observed directly from model-server prefill trace span."
	}

	if totalDur != nil {
		ms := roundMs(float64(totalDur.Nanoseconds()) / 1e6)
		rec.Timings.TotalDurationMs.Value = &ms
		rec.Timings.TotalDurationMs.ObservationKind = measuredKind

		if completionTokens > 0 && ms > 0 {
			e2eTps := roundMs(float64(completionTokens) / (ms / 1000.0))
			rec.Timings.EndToEndTokensPerSec.Value = &e2eTps
			rec.Timings.EndToEndTokensPerSec.ObservationKind = derivedKind
		}

		if ttftDur != nil && completionTokens > 1 {
			decodeWindowSec := (totalDur.Seconds() - ttftDur.Seconds())
			if decodeWindowSec > 0.001 {
				decodeTps := roundMs(float64(completionTokens-1) / decodeWindowSec)
				rec.Timings.DecodeTokensPerSec.Value = &decodeTps
				rec.Timings.DecodeTokensPerSec.ObservationKind = derivedKind
			}
		}
	}

	if len(itlSamplesMs) > 0 {
		cleanSamples := make([]float64, len(itlSamplesMs))
		var sum float64
		for i, v := range itlSamplesMs {
			cleanSamples[i] = roundMs(v)
			sum += v
		}
		rec.Timings.ITLSamplesMs = cleanSamples
		mean := roundMs(sum / float64(len(itlSamplesMs)))
		rec.Timings.MeanITLMs.Value = &mean
		rec.Timings.MeanITLMs.ObservationKind = derivedKind

		sorted := make([]float64, len(cleanSamples))
		copy(sorted, cleanSamples)
		sort.Float64s(sorted)
		idx := int(math.Ceil(0.95*float64(len(sorted)))) - 1
		if idx < 0 {
			idx = 0
		}
		if idx >= len(sorted) {
			idx = len(sorted) - 1
		}
		p95 := roundMs(sorted[idx])
		rec.Timings.P95ITLMs.Value = &p95
		rec.Timings.P95ITLMs.ObservationKind = derivedKind
	}
}

// DefaultTopology returns the initial configured topology node states before observations arrive.
func DefaultTopology(mockMode bool) []NodeState {
	kind := ObservationObserved
	if mockMode {
		kind = ObservationSimulated
	}
	return []NodeState{
		{NodeID: "browser", Status: "observed", ObservationKind: kind, Detail: "Client browser submitting OpenAI chat completion request"},
		{NodeID: "observer-api", Status: "observed", ObservationKind: kind, Detail: "Go Observer API assigning request_id, W3C traceparent, and SSE lifecycle stream"},
		{NodeID: "gateway-proxy", Status: "configured", ObservationKind: ObservationUnavailable, Detail: "Envoy proxy (:8081) in llm-d-router-epp pod"},
		{NodeID: "epp", Status: "configured", ObservationKind: ObservationUnavailable, Detail: "llm-d Endpoint Picker (:9002 gRPC ext_proc) filtering & scoring"},
		{NodeID: "inference-pool", Status: "configured", ObservationKind: ObservationUnavailable, Detail: "InferencePool (inference.networking.k8s.io/v1) endpoint membership"},
		{NodeID: "model-server", Status: "configured", ObservationKind: ObservationUnavailable, Detail: "vLLM CPU Model Server (:8000 Qwen/Qwen2.5-0.5B-Instruct)"},
		{NodeID: "otel-collector", Status: "configured", ObservationKind: ObservationUnavailable, Detail: "OpenTelemetry Collector (:4317 OTLP) -> Jaeger trace backend"},
		{NodeID: "prometheus", Status: "configured", ObservationKind: ObservationAggregate, Detail: "Prometheus / GMP scraping EPP (:9090) and vLLM (:8000) aggregate metrics"},
	}
}

// ComputeTopology updates topology node states based on the actual events and spans recorded for a request.
func ComputeTopology(rec *RequestRecord) []NodeState {
	nodes := DefaultTopology(rec.MockMode)
	byID := make(map[string]*NodeState, len(nodes))
	for i := range nodes {
		byID[nodes[i].NodeID] = &nodes[i]
	}

	kind := ObservationObserved
	if rec.MockMode {
		kind = ObservationSimulated
	}

	for _, ev := range rec.Events {
		switch ev.EventType {
		case EventGatewayForwarded:
			byID["gateway-proxy"].Status = "observed"
			byID["gateway-proxy"].ObservationKind = ev.ObservationKind
			byID["gateway-proxy"].Detail = ev.Message
		case EventQueueObserved, EventRoutingStarted:
			byID["epp"].Status = "observed"
			byID["epp"].ObservationKind = ev.ObservationKind
			byID["epp"].Detail = ev.Message
		case EventEndpointSelected:
			byID["epp"].Status = "observed"
			byID["epp"].ObservationKind = ev.ObservationKind
			byID["inference-pool"].Status = "observed"
			byID["inference-pool"].ObservationKind = ev.ObservationKind
			if ep, ok := ev.Attributes["selected_endpoint"].(string); ok && ep != "" {
				byID["inference-pool"].Detail = fmt.Sprintf("Selected endpoint %s from InferencePool", ep)
			}
		case EventModelRequestStarted, EventModelFirstToken, EventModelToken, EventModelStreamCompleted:
			byID["model-server"].Status = "observed"
			byID["model-server"].ObservationKind = ev.ObservationKind
			byID["model-server"].Detail = ev.Message
		case EventRequestFailed:
			if ev.Component == "epp" || ev.Component == "gateway-proxy" {
				byID[ev.Component].Status = "error"
				byID[ev.Component].ObservationKind = ev.ObservationKind
				byID[ev.Component].Detail = ev.Message
				byID["model-server"].Status = "skipped"
				byID["model-server"].Detail = "Skipped because request was rejected or failed upstream before reaching model server"
			}
		case EventTraceEnriched:
			byID["otel-collector"].Status = "observed"
			byID["otel-collector"].ObservationKind = ev.ObservationKind
			byID["otel-collector"].Detail = ev.Message
		}
	}

	// If request has an explicit SelectedEndpoint, ensure inference-pool and model-server reflect it.
	if rec.SelectedEndpoint != "" {
		byID["epp"].Status = "observed"
		byID["epp"].ObservationKind = kind
		byID["inference-pool"].Status = "observed"
		byID["inference-pool"].ObservationKind = kind
		byID["inference-pool"].Detail = fmt.Sprintf("Selected endpoint %s from InferencePool", rec.SelectedEndpoint)
		if byID["model-server"].Status == "observed" && !strings.Contains(byID["model-server"].Detail, rec.SelectedEndpoint) {
			byID["model-server"].Detail = fmt.Sprintf("%s [endpoint: %s]", byID["model-server"].Detail, rec.SelectedEndpoint)
		}
	}

	// If request completed or failed without EPP observation, mark un-observed intermediate hops appropriately.
	if rec.Status == "completed" || rec.Status == "failed" || rec.Status == "cancelled" {
		if byID["epp"].Status == "configured" {
			if rec.SelectedEndpoint != "" {
				byID["epp"].Status = "observed"
				byID["epp"].ObservationKind = kind
			} else {
				byID["epp"].Status = "unavailable"
				byID["epp"].ObservationKind = ObservationUnavailable
				byID["epp"].Detail = "No per-request EPP header or span was exposed for this request"
			}
		}
		if byID["inference-pool"].Status == "configured" {
			if byID["model-server"].Status == "observed" {
				byID["inference-pool"].Status = "observed"
				byID["inference-pool"].ObservationKind = kind
			} else {
				byID["inference-pool"].Status = "unavailable"
			}
		}
	}

	return nodes
}

func roundMs(v float64) float64 {
	return math.Round(v*100) / 100
}

func cloneRecord(in *RequestRecord) *RequestRecord {
	if in == nil {
		return nil
	}
	out := *in
	if in.CompletedAt != nil {
		t := *in.CompletedAt
		out.CompletedAt = &t
	}
	if in.Timings.EPPTokenCount != nil {
		c := *in.Timings.EPPTokenCount
		out.Timings.EPPTokenCount = &c
	}
	if len(in.CandidateEndpoints) > 0 {
		out.CandidateEndpoints = make([]string, len(in.CandidateEndpoints))
		copy(out.CandidateEndpoints, in.CandidateEndpoints)
	}
	out.Events = make([]EventEnvelope, len(in.Events))
	copy(out.Events, in.Events)
	out.Timings.ITLSamplesMs = make([]float64, len(in.Timings.ITLSamplesMs))
	copy(out.Timings.ITLSamplesMs, in.Timings.ITLSamplesMs)
	out.Trace.Spans = make([]SpanNode, len(in.Trace.Spans))
	copy(out.Trace.Spans, in.Trace.Spans)
	out.Topology = make([]NodeState, len(in.Topology))
	copy(out.Topology, in.Topology)
	return &out
}

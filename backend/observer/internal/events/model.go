package events

import "time"

// SchemaVersion is the stable contract version for browser lifecycle events.
const SchemaVersion = "1"

// EventType enumerates all supported inference lifecycle event types.
type EventType string

const (
	EventRequestAccepted      EventType = "request.accepted"
	EventGatewayForwarded     EventType = "gateway.forwarded"
	EventQueueObserved        EventType = "queue.observed"
	EventRoutingStarted       EventType = "routing.started"
	EventEndpointSelected     EventType = "endpoint.selected"
	EventModelRequestStarted  EventType = "model.request.started"
	EventModelFirstToken      EventType = "model.first_token"
	EventModelToken           EventType = "model.token"
	EventModelStreamCompleted EventType = "model.stream.completed"
	EventRequestCompleted     EventType = "request.completed"
	EventRequestCancelled     EventType = "request.cancelled"
	EventRequestFailed        EventType = "request.failed"
	EventTraceEnriched        EventType = "trace.enriched"
)

// ObservationKind classifies how an event, timing, or metric was obtained.
type ObservationKind string

const (
	ObservationObserved    ObservationKind = "observed"
	ObservationMeasured    ObservationKind = "measured"
	ObservationAggregate   ObservationKind = "aggregate"
	ObservationDerived     ObservationKind = "derived"
	ObservationUnavailable ObservationKind = "unavailable"
	ObservationSimulated   ObservationKind = "simulated"
)

// EventEnvelope is the wire schema emitted over SSE and returned by /api/requests/{id}/events.
type EventEnvelope struct {
	SchemaVersion   string          `json:"schema_version"`
	RequestID       string          `json:"request_id"`
	TraceID         string          `json:"trace_id,omitempty"`
	EventID         string          `json:"event_id"`
	Sequence        int             `json:"sequence"`
	EventType       EventType       `json:"event_type"`
	Source          string          `json:"source"`
	SourceTimestamp string          `json:"source_timestamp"`
	ObservationKind ObservationKind `json:"observation_kind"`
	Component       string          `json:"component"`
	Message         string          `json:"message"`
	DurationNs      *int64          `json:"duration_ns"`
	Attributes      map[string]any  `json:"attributes"`
}

// ClassifiedValue pairs a numeric value with its observation classification and data source metadata.
type ClassifiedValue struct {
	Value           *float64        `json:"value"`
	Unit            string          `json:"unit"`
	ObservationKind ObservationKind `json:"observation_kind"`
	Source          string          `json:"source"`
	Explanation     string          `json:"explanation"`
}

// TimingBreakdown holds per-request measured and derived timings with explicit provenance.
type TimingBreakdown struct {
	RequestStartTimestamp  string          `json:"request_start_timestamp"`
	UpstreamHeadersMs      ClassifiedValue `json:"upstream_headers_ms"`
	TTFTMs                 ClassifiedValue `json:"ttft_ms"`
	PrefillDurationMs      ClassifiedValue `json:"prefill_duration_ms"`
	TotalDurationMs        ClassifiedValue `json:"total_duration_ms"`
	MeanITLMs              ClassifiedValue `json:"mean_itl_ms"`
	P95ITLMs               ClassifiedValue `json:"p95_itl_ms"`
	DecodeTokensPerSec     ClassifiedValue `json:"decode_tokens_per_sec"`
	EndToEndTokensPerSec   ClassifiedValue `json:"e2e_tokens_per_sec"`
	ITLSamplesMs           []float64       `json:"itl_samples_ms"`
	PromptTokens           int             `json:"prompt_tokens"`
	CompletionTokens       int             `json:"completion_tokens"`
	PromptTokensSource     string          `json:"prompt_tokens_source,omitempty"`
	CompletionTokensSource string          `json:"completion_tokens_source,omitempty"`
	EPPTokenCount          *int            `json:"epp_token_count,omitempty"`
	EPPTokenBackend        string          `json:"epp_token_backend,omitempty"`
}

// SpanNode represents a trace span correlated with the inference request.
type SpanNode struct {
	SpanID          string          `json:"span_id"`
	ParentSpanID    string          `json:"parent_span_id,omitempty"`
	TraceID         string          `json:"trace_id"`
	OperationName   string          `json:"operation_name"`
	ServiceName     string          `json:"service_name"`
	Component       string          `json:"component"`
	StartTime       string          `json:"start_time"`
	EndTime         string          `json:"end_time"`
	DurationNs      int64           `json:"duration_ns"`
	ObservationKind ObservationKind `json:"observation_kind"`
	Status          string          `json:"status"`
	Attributes      map[string]any  `json:"attributes"`
}

// TraceRecord holds the trace correlation state for a request.
type TraceRecord struct {
	RequestID       string          `json:"request_id"`
	TraceID         string          `json:"trace_id"`
	Status          string          `json:"status"` // pending | enriched | partial | unavailable | timeout
	ObservationKind ObservationKind `json:"observation_kind"`
	Backend         string          `json:"backend"`
	EnrichedAt      string          `json:"enriched_at,omitempty"`
	ErrorMessage    string          `json:"error_message,omitempty"`
	Spans           []SpanNode      `json:"spans"`
}

// NodeState describes how a topology node participated in a request.
type NodeState struct {
	NodeID          string          `json:"node_id"`
	Status          string          `json:"status"` // observed | skipped | unavailable | configured | error
	ObservationKind ObservationKind `json:"observation_kind"`
	Detail          string          `json:"detail"`
}

// RequestRecord stores the complete lifecycle state of a single inference request in memory.
type RequestRecord struct {
	RequestID          string          `json:"request_id"`
	TraceID            string          `json:"trace_id"`
	Model              string          `json:"model"`
	RouterMode         string          `json:"router_mode"`
	PriorityBand       string          `json:"priority_band"`
	Stream             bool            `json:"stream"`
	MockMode           bool            `json:"mock_mode"`
	Scenario           string          `json:"scenario,omitempty"`
	Status             string          `json:"status"` // in_flight | completed | cancelled | failed
	HTTPStatus         int             `json:"http_status"`
	FailureScope       string          `json:"failure_scope,omitempty"` // rejected_prerouting | routed_upstream_error
	SelectedEndpoint   string          `json:"selected_endpoint,omitempty"`
	CandidateEndpoints []string        `json:"candidate_endpoints,omitempty"`
	CreatedAt          time.Time       `json:"created_at"`
	CompletedAt        *time.Time      `json:"completed_at,omitempty"`
	ErrorMessage       string          `json:"error_message,omitempty"`
	PromptMetadata     map[string]any  `json:"prompt_metadata"`
	Timings            TimingBreakdown `json:"timings"`
	Events             []EventEnvelope `json:"events"`
	Trace              TraceRecord     `json:"trace"`
	Topology           []NodeState     `json:"topology"`
}

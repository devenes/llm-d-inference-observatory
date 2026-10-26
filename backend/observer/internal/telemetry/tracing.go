package telemetry

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/redact"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// TracerManager wraps OpenTelemetry TracerProvider, W3C propagation, and Jaeger trace lookup.
type TracerManager struct {
	provider      *sdktrace.TracerProvider
	tracer        trace.Tracer
	propagator    propagation.TextMapPropagator
	jaegerURL     string
	queryTimeout  time.Duration
	redactPrompts bool
	httpClient    *http.Client
}

// NewTracerManager initializes the OpenTelemetry SDK and W3C TraceContext propagator.
func NewTracerManager(ctx context.Context, cfg config.Config) (*TracerManager, error) {
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("observer-api"),
			semconv.ServiceVersion(config.Version),
			attribute.String("k8s.cluster.name", cfg.ClusterName),
			attribute.String("k8s.namespace.name", cfg.Namespace),
			attribute.String("llm_d.component", "observer-api"),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to build otel resource: %w", err)
	}

	opts := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(1.0))),
	}

	if cfg.OTLPEndpoint != "" {
		endpoint := strings.TrimPrefix(strings.TrimPrefix(cfg.OTLPEndpoint, "http://"), "https://")
		exp, expErr := otlptracehttp.New(ctx,
			otlptracehttp.WithEndpoint(endpoint),
			otlptracehttp.WithInsecure(),
		)
		if expErr == nil {
			opts = append(opts, sdktrace.WithBatcher(exp))
		}
	}

	tp := sdktrace.NewTracerProvider(opts...)
	prop := propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{})
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(prop)

	return &TracerManager{
		provider:      tp,
		tracer:        tp.Tracer("github.com/devenes/llm-d-inference-observatory/backend/observer"),
		propagator:    prop,
		jaegerURL:     strings.TrimRight(cfg.JaegerQueryURL, "/"),
		queryTimeout:  cfg.TraceQueryTimeout,
		redactPrompts: cfg.RedactPrompts,
		httpClient: &http.Client{
			Timeout: cfg.TraceQueryTimeout,
		},
	}, nil
}

// StartRequestSpan begins a new root or child span for an inference request and returns the W3C trace ID and span ID.
func (tm *TracerManager) StartRequestSpan(ctx context.Context, reqID, model, routerMode string, stream bool) (context.Context, trace.Span, string, string) {
	ctx, span := tm.tracer.Start(ctx, "observer.infer",
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(
			attribute.String("llm_d.request_id", reqID),
			attribute.String("gen_ai.request.model", model),
			attribute.String("llm_d.router_mode", routerMode),
			attribute.Bool("llm_d.stream", stream),
		),
	)
	sc := span.SpanContext()
	return ctx, span, sc.TraceID().String(), sc.SpanID().String()
}

// InjectHeaders writes W3C traceparent and tracestate headers onto an outgoing HTTP request.
func (tm *TracerManager) InjectHeaders(ctx context.Context, hdr http.Header) {
	tm.propagator.Inject(ctx, propagation.HeaderCarrier(hdr))
}

// ExtractContext reads W3C traceparent headers from an incoming HTTP request if present.
func (tm *TracerManager) ExtractContext(ctx context.Context, hdr http.Header) context.Context {
	return tm.propagator.Extract(ctx, propagation.HeaderCarrier(hdr))
}

// Shutdown flushes pending spans cleanly.
func (tm *TracerManager) Shutdown(ctx context.Context) error {
	if tm == nil || tm.provider == nil {
		return nil
	}
	return tm.provider.Shutdown(ctx)
}

// jaegerResponse matches Jaeger's /api/traces/{traceID} JSON structure.
type jaegerResponse struct {
	Data []struct {
		TraceID   string `json:"traceID"`
		Processes map[string]struct {
			ServiceName string `json:"serviceName"`
		} `json:"processes"`
		Spans []struct {
			TraceID       string `json:"traceID"`
			SpanID        string `json:"spanID"`
			OperationName string `json:"operationName"`
			StartTime     int64  `json:"startTime"` // microseconds since epoch
			Duration      int64  `json:"duration"`  // microseconds
			ProcessID     string `json:"processID"`
			References    []struct {
				RefType string `json:"refType"`
				SpanID  string `json:"spanID"`
			} `json:"references"`
			Tags []struct {
				Key   string `json:"key"`
				Value any    `json:"value"`
			} `json:"tags"`
		} `json:"spans"`
	} `json:"data"`
}

// FetchJaegerTrace queries the Jaeger HTTP API for spans belonging to traceID.
func (tm *TracerManager) FetchJaegerTrace(ctx context.Context, traceID string) ([]events.SpanNode, error) {
	if tm.jaegerURL == "" || traceID == "" {
		return nil, fmt.Errorf("jaeger query URL or trace ID not configured")
	}
	qCtx, cancel := context.WithTimeout(ctx, tm.queryTimeout)
	defer cancel()

	url := fmt.Sprintf("%s/api/traces/%s", tm.jaegerURL, traceID)
	req, err := http.NewRequestWithContext(qCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := tm.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jaeger query failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("jaeger returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var parsed jaegerResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("invalid jaeger JSON: %w", err)
	}
	if len(parsed.Data) == 0 || len(parsed.Data[0].Spans) == 0 {
		return nil, fmt.Errorf("no spans found for trace %s", traceID)
	}

	traceData := parsed.Data[0]
	spans := make([]events.SpanNode, 0, len(traceData.Spans))
	for _, s := range traceData.Spans {
		svcName := "unknown"
		if proc, ok := traceData.Processes[s.ProcessID]; ok && proc.ServiceName != "" {
			svcName = proc.ServiceName
		}
		parentID := ""
		for _, ref := range s.References {
			if strings.EqualFold(ref.RefType, "CHILD_OF") {
				parentID = ref.SpanID
				break
			}
		}
		rawAttrs := make(map[string]any, len(s.Tags))
		status := "ok"
		for _, t := range s.Tags {
			rawAttrs[t.Key] = t.Value
			if t.Key == "error" && t.Value == true {
				status = "error"
			}
		}
		startTime := time.UnixMicro(s.StartTime).UTC()
		endTime := time.UnixMicro(s.StartTime + s.Duration).UTC()
		spans = append(spans, events.SpanNode{
			SpanID:          s.SpanID,
			ParentSpanID:    parentID,
			TraceID:         s.TraceID,
			OperationName:   s.OperationName,
			ServiceName:     svcName,
			Component:       mapServiceToComponent(svcName),
			StartTime:       startTime.Format(time.RFC3339Nano),
			EndTime:         endTime.Format(time.RFC3339Nano),
			DurationNs:      s.Duration * 1000,
			ObservationKind: events.ObservationObserved,
			Status:          status,
			Attributes:      redact.SanitizeAttributes(rawAttrs, tm.redactPrompts),
		})
	}
	return spans, nil
}

func mapServiceToComponent(serviceName string) string {
	lower := strings.ToLower(serviceName)
	switch {
	case strings.Contains(lower, "observer"):
		return "observer-api"
	case strings.Contains(lower, "epp") || strings.Contains(lower, "endpoint-picker"):
		return "epp"
	case strings.Contains(lower, "envoy") || strings.Contains(lower, "gateway") || strings.Contains(lower, "proxy"):
		return "gateway-proxy"
	case strings.Contains(lower, "vllm") || strings.Contains(lower, "model"):
		return "model-server"
	default:
		return serviceName
	}
}

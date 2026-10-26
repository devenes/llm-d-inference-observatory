package upstream

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/config"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/events"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/redact"
	"github.com/devenes/llm-d-inference-observatory/backend/observer/internal/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// ChatMessage represents an OpenAI-compatible chat message.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// InferRequest represents the incoming inference request from the browser or benchmark client.
type InferRequest struct {
	Model        string        `json:"model"`
	Messages     []ChatMessage `json:"messages"`
	Prompt       string        `json:"prompt,omitempty"`
	Temperature  *float64      `json:"temperature,omitempty"`
	MaxTokens    int           `json:"max_tokens,omitempty"`
	Stream       bool          `json:"stream"`
	RouterMode   string        `json:"router_mode,omitempty"`
	PriorityBand string        `json:"priority_band,omitempty"` // premium-traffic | standard-traffic | best-effort-traffic
	FairnessID   string        `json:"fairness_id,omitempty"`
	Scenario     string        `json:"scenario,omitempty"`     // Only honored when server is in MockMode
	UpstreamURL  string        `json:"upstream_url,omitempty"` // Explicitly rejected if non-empty to prevent SSRF
}

// ExtractPromptText combines message contents or prompt field for token estimation and redaction summary.
func (r InferRequest) ExtractPromptText() string {
	if len(r.Messages) > 0 {
		parts := make([]string, 0, len(r.Messages))
		for _, m := range r.Messages {
			if strings.TrimSpace(m.Content) != "" {
				parts = append(parts, m.Content)
			}
		}
		return strings.Join(parts, "\n")
	}
	return r.Prompt
}

// Client forwards real OpenAI-compatible requests to the allowlisted llm-d upstream.
type Client struct {
	cfg          config.Config
	httpClient   *http.Client
	k8sClient    *http.Client
	hub          *events.Hub
	tracer       *telemetry.TracerManager
	metrics      *telemetry.MetricsCollector
	podIPMu      sync.RWMutex
	podIPMap     map[string]string
	podIPUpdated time.Time
}

// NewClient constructs a real upstream client with streaming support and no response buffering timeout traps.
func NewClient(cfg config.Config, hub *events.Hub, tracer *telemetry.TracerManager, metrics *telemetry.MetricsCollector) *Client {
	return &Client{
		cfg: cfg,
		httpClient: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:          100,
				IdleConnTimeout:       90 * time.Second,
				ResponseHeaderTimeout: cfg.RequestTimeout,
			},
		},
		k8sClient: &http.Client{
			Timeout: 800 * time.Millisecond,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		},
		hub:      hub,
		tracer:   tracer,
		metrics:  metrics,
		podIPMap: make(map[string]string),
	}
}

// resolveEndpoint maps an x-gateway-destination-endpoint IP:Port (e.g. "10.20.1.14:8000")
// to its Kubernetes Pod name in the target namespace when running in-cluster.
func (c *Client) resolveEndpoint(ctx context.Context, rawEndpoint string) string {
	rawEndpoint = strings.TrimSpace(rawEndpoint)
	if rawEndpoint == "" {
		return ""
	}
	host := rawEndpoint
	if h, _, err := net.SplitHostPort(rawEndpoint); err == nil && h != "" {
		host = h
	}
	if net.ParseIP(host) == nil {
		return rawEndpoint
	}

	c.podIPMu.RLock()
	podName, ok := c.podIPMap[host]
	fresh := time.Since(c.podIPUpdated) < 15*time.Second
	c.podIPMu.RUnlock()

	if !ok && !fresh {
		c.refreshPodIPMap(ctx)
		c.podIPMu.RLock()
		podName, ok = c.podIPMap[host]
		c.podIPMu.RUnlock()
	}

	if ok && podName != "" {
		return fmt.Sprintf("%s (%s)", podName, rawEndpoint)
	}
	return rawEndpoint
}

func (c *Client) refreshPodIPMap(ctx context.Context) {
	k8sHost := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST"))
	k8sPort := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_PORT"))
	if k8sHost == "" {
		return
	}
	if k8sPort == "" {
		k8sPort = "443"
	}
	tokenBytes, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
	if err != nil {
		return
	}
	ns := c.cfg.Namespace
	if ns == "" {
		ns = "llm-d-observatory"
	}

	apiURL := fmt.Sprintf("https://%s/api/v1/namespaces/%s/pods", net.JoinHostPort(k8sHost, k8sPort), ns)
	qCtx, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(qCtx, http.MethodGet, apiURL, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(tokenBytes)))

	resp, err := c.k8sClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}

	var podList struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
			Status struct {
				PodIP string `json:"podIP"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&podList); err != nil {
		return
	}

	c.podIPMu.Lock()
	defer c.podIPMu.Unlock()
	for _, item := range podList.Items {
		if item.Status.PodIP != "" && item.Metadata.Name != "" {
			fullName := item.Metadata.Name
			if item.Metadata.Namespace != "" {
				fullName = item.Metadata.Namespace + "/" + item.Metadata.Name
			}
			c.podIPMap[item.Status.PodIP] = fullName
		}
	}
	c.podIPUpdated = time.Now()
}

// Forward executes an OpenAI chat completion call against the configured llm-d upstream and streams or writes the response.
func (c *Client) Forward(ctx context.Context, reqID string, startTime time.Time, inferReq InferRequest, w http.ResponseWriter, streamToClient bool) {
	if err := c.cfg.ValidateUpstreamURL(c.cfg.UpstreamURL); err != nil {
		c.failRequest(reqID, startTime, http.StatusBadGateway, "upstream URL failed allowlist validation: "+err.Error(), false, "", w, streamToClient)
		return
	}

	upstreamPayload := map[string]any{
		"model":    inferReq.Model,
		"messages": inferReq.Messages,
		"stream":   inferReq.Stream,
	}
	if inferReq.Stream {
		// Request exact tokenizer usage (prompt_tokens, completion_tokens) in the final SSE chunk from vLLM.
		upstreamPayload["stream_options"] = map[string]any{
			"include_usage": true,
		}
	}
	if inferReq.MaxTokens > 0 {
		upstreamPayload["max_tokens"] = inferReq.MaxTokens
	}
	if inferReq.Temperature != nil {
		upstreamPayload["temperature"] = *inferReq.Temperature
	}

	bodyBytes, err := json.Marshal(upstreamPayload)
	if err != nil {
		c.failRequest(reqID, startTime, http.StatusInternalServerError, "failed to encode upstream request", false, "", w, streamToClient)
		return
	}

	targetEndpoint := strings.TrimRight(c.cfg.UpstreamURL, "/") + "/v1/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, targetEndpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		c.failRequest(reqID, startTime, http.StatusInternalServerError, "failed to create upstream request", false, "", w, streamToClient)
		return
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Request-Id", reqID)
	if inferReq.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	}
	if inferReq.PriorityBand != "" {
		httpReq.Header.Set("x-llm-d-inference-objective", inferReq.PriorityBand)
	}
	if inferReq.FairnessID != "" {
		httpReq.Header.Set("x-llm-d-inference-fairness-id", inferReq.FairnessID)
	}
	if c.tracer != nil {
		c.tracer.InjectHeaders(ctx, httpReq.Header)
	}

	forwardDurNs := time.Since(startTime).Nanoseconds()
	c.hub.Emit(reqID, events.EventGatewayForwarded, "observer-api", "gateway-proxy",
		"Forwarded OpenAI chat completion request to llm-d Envoy/EPP router",
		events.ObservationObserved, &forwardDurNs, map[string]any{
			"upstream_endpoint": targetEndpoint,
			"stream":            inferReq.Stream,
			"priority_band":     inferReq.PriorityBand,
			"traceparent_sent":  httpReq.Header.Get("traceparent") != "",
		})

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			c.cancelRequest(reqID, startTime, 0, 0, nil)
			return
		}
		c.failRequest(reqID, startTime, http.StatusBadGateway, fmt.Sprintf("upstream connection error: %v", err), false, "", w, streamToClient)
		return
	}
	defer resp.Body.Close()

	headersDur := time.Since(startTime)
	headersDurNs := headersDur.Nanoseconds()

	// Inspect real llm-d / EPP headers when present. Never fabricate EPP events or infer endpoints from rankings.
	droppedReason := resp.Header.Get("x-llm-d-request-dropped-reason")
	eppRespMarker := resp.Header.Get("x-went-into-resp-headers")
	rawSelectedEndpoint := strings.TrimSpace(resp.Header.Get("x-gateway-destination-endpoint"))
	selectedEndpoint := c.resolveEndpoint(ctx, rawSelectedEndpoint)
	routedToUpstream := eppRespMarker == "true" || rawSelectedEndpoint != ""

	if selectedEndpoint != "" {
		if span := trace.SpanFromContext(ctx); span != nil && span.IsRecording() {
			attrs := []attribute.KeyValue{
				attribute.String("llm_d.selected_endpoint", selectedEndpoint),
			}
			if rawSelectedEndpoint != "" {
				attrs = append(attrs, attribute.String("x-gateway-destination-endpoint", rawSelectedEndpoint))
			}
			span.SetAttributes(attrs...)
		}
		c.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
			rec.SelectedEndpoint = selectedEndpoint
		})
	}

	if droppedReason != "" || resp.StatusCode == http.StatusTooManyRequests {
		c.hub.Emit(reqID, events.EventQueueObserved, "llm-d-router-epp", "epp",
			fmt.Sprintf("EPP flow-control admission rejected request (HTTP %d, reason=%s)", resp.StatusCode, nonEmpty(droppedReason, "rate_limited")),
			events.ObservationObserved, &headersDurNs, map[string]any{
				"http_status":    resp.StatusCode,
				"dropped_reason": droppedReason,
			})
	}

	if eppRespMarker != "" || selectedEndpoint != "" {
		c.hub.Emit(reqID, events.EventRoutingStarted, "llm-d-router-epp", "epp",
			"EPP external processor evaluated request headers and body",
			events.ObservationObserved, nil, map[string]any{
				"x_went_into_resp_headers": eppRespMarker,
			})
	}

	if selectedEndpoint != "" {
		c.hub.Emit(reqID, events.EventEndpointSelected, "llm-d-router-epp", "inference-pool",
			fmt.Sprintf("EPP selected model server endpoint %s", selectedEndpoint),
			events.ObservationObserved, nil, map[string]any{
				"selected_endpoint":              selectedEndpoint,
				"x_gateway_destination_endpoint": rawSelectedEndpoint,
			})
	} else if eppRespMarker == "true" {
		c.hub.Emit(reqID, events.EventEndpointSelected, "llm-d-router-epp", "inference-pool",
			"EPP ext_proc routed request through InferencePool (x-went-into-resp-headers=true; destination IP header not exposed)",
			events.ObservationObserved, nil, map[string]any{
				"x_went_into_resp_headers": eppRespMarker,
			})
	}

	if resp.StatusCode >= 400 {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		msg := fmt.Sprintf("upstream returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(errBody)))
		c.failRequest(reqID, startTime, resp.StatusCode, msg, routedToUpstream, selectedEndpoint, w, streamToClient)
		return
	}

	c.hub.Emit(reqID, events.EventModelRequestStarted, "vllm-model-server", "model-server",
		fmt.Sprintf("Upstream HTTP %d response headers received from model server", resp.StatusCode),
		events.ObservationMeasured, &headersDurNs, map[string]any{
			"http_status":        resp.StatusCode,
			"content_type":       resp.Header.Get("Content-Type"),
			"selected_endpoint":  selectedEndpoint,
			"headers_latency_ms": float64(headersDur.Nanoseconds()) / 1e6,
		})

	promptTokens := redact.EstimateTokens(inferReq.ExtractPromptText())

	if inferReq.Stream {
		c.handleStreamingResponse(ctx, reqID, startTime, headersDur, selectedEndpoint, promptTokens, resp, w, streamToClient)
	} else {
		c.handleNonStreamingResponse(ctx, reqID, startTime, headersDur, selectedEndpoint, promptTokens, resp, w)
	}
}

func (c *Client) handleStreamingResponse(ctx context.Context, reqID string, startTime time.Time, headersDur time.Duration, selectedEndpoint string, promptTokens int, resp *http.Response, w http.ResponseWriter, streamToClient bool) {
	var flusher http.Flusher
	if streamToClient && w != nil {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.Header().Set("X-Request-Id", reqID)
		w.WriteHeader(http.StatusOK)
		flusher, _ = w.(http.Flusher)
		if flusher != nil {
			flusher.Flush()
		}
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 512*1024)

	var (
		ttftDur                *time.Duration
		lastTokenTime          time.Time
		itlSamplesMs           []float64
		completionTokens       int
		promptTokensSource     = "observer_char_estimate"
		completionTokensSource = "sse_chunk_count"
	)

	for scanner.Scan() {
		if ctx.Err() != nil {
			c.cancelRequest(reqID, startTime, promptTokens, completionTokens, ttftDur)
			return
		}
		line := scanner.Text()
		if streamToClient && w != nil {
			_, _ = fmt.Fprintf(w, "%s\n", line)
			if flusher != nil {
				flusher.Flush()
			}
		}

		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
		if payload == "[DONE]" {
			streamDoneDur := time.Since(startTime).Nanoseconds()
			c.hub.Emit(reqID, events.EventModelStreamCompleted, "vllm-model-server", "model-server",
				"Received [DONE] sentinel from upstream SSE token stream",
				events.ObservationObserved, &streamDoneDur, map[string]any{
					"completion_tokens":        completionTokens,
					"prompt_tokens":            promptTokens,
					"prompt_tokens_source":     promptTokensSource,
					"completion_tokens_source": completionTokensSource,
				})
			break
		}

		// Parse OpenAI chunk to distinguish metadata-only role chunks from real non-empty content tokens (True TTFT).
		var chunk struct {
			Choices []struct {
				Delta struct {
					Role    string `json:"role"`
					Content string `json:"content"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if chunk.Usage != nil {
			if chunk.Usage.PromptTokens > 0 {
				promptTokens = chunk.Usage.PromptTokens
				promptTokensSource = "vllm_usage"
			}
			if chunk.Usage.CompletionTokens > 0 {
				completionTokens = chunk.Usage.CompletionTokens
				completionTokensSource = "vllm_usage"
			}
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		deltaContent := chunk.Choices[0].Delta.Content
		if deltaContent == "" {
			// Initial role chunk (e.g., {"role":"assistant","content":""}); do NOT count as first token!
			continue
		}

		now := time.Now()
		completionTokens++
		if ttftDur == nil {
			d := now.Sub(startTime)
			ttftDur = &d
			ttftNs := d.Nanoseconds()
			lastTokenTime = now
			c.hub.Emit(reqID, events.EventModelFirstToken, "observer-api", "model-server",
				fmt.Sprintf("First non-empty generated token arrived (True TTFT %.2f ms)", float64(ttftNs)/1e6),
				events.ObservationMeasured, &ttftNs, map[string]any{
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
			c.hub.Emit(reqID, events.EventModelToken, "observer-api", "model-server",
				fmt.Sprintf("Streamed token #%d (ITL %.2f ms)", completionTokens, itlMs),
				events.ObservationMeasured, &itlNs, map[string]any{
					"token_index": completionTokens,
					"itl_ms":      itlMs,
				})
		}
	}

	if err := scanner.Err(); err != nil && errors.Is(ctx.Err(), context.Canceled) {
		c.cancelRequest(reqID, startTime, promptTokens, completionTokens, ttftDur)
		return
	}

	if span := trace.SpanFromContext(ctx); span != nil && span.IsRecording() {
		span.SetAttributes(
			attribute.Int("gen_ai.usage.input_tokens", promptTokens),
			attribute.Int("gen_ai.usage.output_tokens", completionTokens),
			attribute.String("llm_d.prompt_tokens_source", promptTokensSource),
		)
	}

	totalDur := time.Since(startTime)
	totalNs := totalDur.Nanoseconds()
	completedAt := time.Now().UTC()

	c.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
		rec.Status = "completed"
		rec.HTTPStatus = http.StatusOK
		if selectedEndpoint != "" {
			rec.SelectedEndpoint = selectedEndpoint
		}
		rec.CompletedAt = &completedAt
		events.FinalizeTimings(rec, &headersDur, ttftDur, &totalDur, itlSamplesMs, promptTokens, completionTokens, nil)
		rec.Timings.PromptTokensSource = promptTokensSource
		rec.Timings.CompletionTokensSource = completionTokensSource
	})

	c.hub.Emit(reqID, events.EventRequestCompleted, "observer-api", "observer-api",
		fmt.Sprintf("Streaming inference completed (%d tokens in %.2f ms)", completionTokens, float64(totalNs)/1e6),
		events.ObservationMeasured, &totalNs, map[string]any{
			"prompt_tokens":            promptTokens,
			"prompt_tokens_source":     promptTokensSource,
			"completion_tokens":        completionTokens,
			"completion_tokens_source": completionTokensSource,
			"selected_endpoint":        selectedEndpoint,
			"total_duration_ms":        float64(totalNs) / 1e6,
		})

	if rec, ok := c.hub.GetRequest(reqID); ok {
		c.metrics.RecordCompletion("completed", rec.Timings.TTFTMs.Value, rec.Timings.MeanITLMs.Value, rec.Timings.TotalDurationMs.Value, rec.Timings.DecodeTokensPerSec.Value, promptTokens, completionTokens)
		go c.enrichTraceAsync(rec.RequestID, rec.TraceID)
	}
}

func (c *Client) handleNonStreamingResponse(ctx context.Context, reqID string, startTime time.Time, headersDur time.Duration, selectedEndpoint string, promptTokens int, resp *http.Response, w http.ResponseWriter) {
	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			c.cancelRequest(reqID, startTime, promptTokens, 0, nil)
			return
		}
		c.failRequest(reqID, startTime, http.StatusBadGateway, "failed reading upstream response body", true, selectedEndpoint, w, false)
		return
	}

	var parsed struct {
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(bodyBytes, &parsed)
	completionTokens := 0
	promptTokensSource := "observer_char_estimate"
	completionTokensSource := "observer_char_estimate"
	if parsed.Usage != nil {
		if parsed.Usage.PromptTokens > 0 {
			promptTokens = parsed.Usage.PromptTokens
			promptTokensSource = "vllm_usage"
		}
		completionTokens = parsed.Usage.CompletionTokens
		completionTokensSource = "vllm_usage"
	} else if len(parsed.Choices) > 0 {
		completionTokens = redact.EstimateTokens(parsed.Choices[0].Message.Content)
	}

	if span := trace.SpanFromContext(ctx); span != nil && span.IsRecording() {
		span.SetAttributes(
			attribute.Int("gen_ai.usage.input_tokens", promptTokens),
			attribute.Int("gen_ai.usage.output_tokens", completionTokens),
			attribute.String("llm_d.prompt_tokens_source", promptTokensSource),
		)
	}

	totalDur := time.Since(startTime)
	totalNs := totalDur.Nanoseconds()
	completedAt := time.Now().UTC()

	c.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
		rec.Status = "completed"
		rec.HTTPStatus = http.StatusOK
		if selectedEndpoint != "" {
			rec.SelectedEndpoint = selectedEndpoint
		}
		rec.CompletedAt = &completedAt
		events.FinalizeTimings(rec, &headersDur, nil, &totalDur, nil, promptTokens, completionTokens, nil)
		rec.Timings.PromptTokensSource = promptTokensSource
		rec.Timings.CompletionTokensSource = completionTokensSource
	})

	c.hub.Emit(reqID, events.EventRequestCompleted, "observer-api", "observer-api",
		fmt.Sprintf("Non-streaming inference completed (%d tokens in %.2f ms)", completionTokens, float64(totalNs)/1e6),
		events.ObservationMeasured, &totalNs, map[string]any{
			"prompt_tokens":            promptTokens,
			"prompt_tokens_source":     promptTokensSource,
			"completion_tokens":        completionTokens,
			"completion_tokens_source": completionTokensSource,
			"selected_endpoint":        selectedEndpoint,
			"total_duration_ms":        float64(totalNs) / 1e6,
		})

	if rec, ok := c.hub.GetRequest(reqID); ok {
		c.metrics.RecordCompletion("completed", nil, nil, rec.Timings.TotalDurationMs.Value, rec.Timings.EndToEndTokensPerSec.Value, promptTokens, completionTokens)
		go c.enrichTraceAsync(rec.RequestID, rec.TraceID)
	}

	if w != nil {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", reqID)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(bodyBytes)
	}
}

func (c *Client) enrichTraceAsync(reqID, traceID string) {
	if c.tracer == nil || traceID == "" {
		return
	}
	_ = c.tracer.ForceFlush(context.Background())

	var (
		spans   []events.SpanNode
		lastErr error
	)
	backoff := []time.Duration{
		200 * time.Millisecond,
		450 * time.Millisecond,
		800 * time.Millisecond,
		1200 * time.Millisecond,
	}
	for i, wait := range backoff {
		time.Sleep(wait)
		s, err := c.tracer.FetchJaegerTrace(context.Background(), traceID)
		if err == nil && len(s) > 0 {
			spans = s
			// If we only got 1 span (observer-api) on an early poll, wait for otel-collector's batch flush of EPP spans.
			if len(s) == 1 && i < len(backoff)-1 {
				continue
			}
			lastErr = nil
			break
		}
		lastErr = err
	}

	if len(spans) == 0 {
		errMsg := "no trace spans returned from Jaeger"
		if lastErr != nil {
			errMsg = lastErr.Error()
		}
		c.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
			rec.Trace.Status = "unavailable"
			rec.Trace.ObservationKind = events.ObservationUnavailable
			rec.Trace.ErrorMessage = errMsg
		})
		return
	}

	spanEndpoint := c.resolveEndpoint(context.Background(), ExtractEndpointFromSpans(spans))
	candidateEndpoints := ExtractCandidateEndpointsFromSpans(spans)
	eppTokCount, eppTokBackend := ExtractEPPTokenInfoFromSpans(spans)
	nowStr := time.Now().UTC().Format(time.RFC3339Nano)
	var finalSelected string
	c.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
		rec.Trace.Status = "enriched"
		rec.Trace.ObservationKind = events.ObservationObserved
		rec.Trace.EnrichedAt = nowStr
		rec.Trace.ErrorMessage = ""
		rec.Trace.Spans = spans
		if rec.SelectedEndpoint == "" && spanEndpoint != "" {
			rec.SelectedEndpoint = spanEndpoint
		}
		if len(candidateEndpoints) > 0 {
			rec.CandidateEndpoints = candidateEndpoints
		}
		if eppTokCount != nil {
			rec.Timings.EPPTokenCount = eppTokCount
		}
		if eppTokBackend != "" {
			rec.Timings.EPPTokenBackend = eppTokBackend
		}
		finalSelected = rec.SelectedEndpoint
	})

	c.hub.Emit(reqID, events.EventTraceEnriched, "jaeger-query", "otel-collector",
		fmt.Sprintf("Correlated %d distributed OpenTelemetry trace spans from Jaeger", len(spans)),
		events.ObservationObserved, nil, map[string]any{
			"span_count":          len(spans),
			"trace_id":            traceID,
			"selected_endpoint":   finalSelected,
			"candidate_endpoints": candidateEndpoints,
			"epp_token_count":     eppTokCount,
			"epp_token_backend":   eppTokBackend,
		})
}

// ExtractEndpointFromSpans inspects spans for an explicit selected endpoint attribute.
// It NEVER infers the selected endpoint from candidate rankings (llm_d.epp.picker.top_endpoints).
func ExtractEndpointFromSpans(spans []events.SpanNode) string {
	keys := []string{"llm_d.selected_endpoint", "selected_endpoint", "x-gateway-destination-endpoint", "x_gateway_destination_endpoint", "target_pod", "endpoint"}
	for _, sp := range spans {
		for _, k := range keys {
			if v, ok := sp.Attributes[k]; ok {
				if s, isStr := v.(string); isStr && strings.TrimSpace(s) != "" {
					return strings.TrimSpace(s)
				}
			}
		}
	}
	return ""
}

// ExtractCandidateEndpointsFromSpans extracts EPP candidate rankings from llm_d.epp.picker.top_endpoints
// without treating candidate rankings as the selected endpoint.
func ExtractCandidateEndpointsFromSpans(spans []events.SpanNode) []string {
	for _, sp := range spans {
		if v, ok := sp.Attributes["llm_d.epp.picker.top_endpoints"]; ok {
			if s, isStr := v.(string); isStr && strings.TrimSpace(s) != "" {
				var list []string
				if err := json.Unmarshal([]byte(s), &list); err == nil && len(list) > 0 {
					return list
				}
				return []string{strings.TrimSpace(s)}
			}
		}
	}
	return nil
}

// ExtractEPPTokenInfoFromSpans extracts llm_d.epp.token_producer.token_count and backend from EPP's tokenize span.
func ExtractEPPTokenInfoFromSpans(spans []events.SpanNode) (*int, string) {
	var (
		tokCount *int
		backend  string
	)
	for _, sp := range spans {
		if v, ok := sp.Attributes["llm_d.epp.token_producer.backend"]; ok {
			if s, isStr := v.(string); isStr && strings.TrimSpace(s) != "" {
				backend = strings.TrimSpace(s)
			}
		}
		if v, ok := sp.Attributes["llm_d.epp.token_producer.token_count"]; ok {
			switch val := v.(type) {
			case float64:
				iv := int(val)
				tokCount = &iv
			case int:
				iv := val
				tokCount = &iv
			case int64:
				iv := int(val)
				tokCount = &iv
			case string:
				if parsed, err := strconv.Atoi(strings.TrimSpace(val)); err == nil {
					tokCount = &parsed
				}
			}
		}
	}
	return tokCount, backend
}

func (c *Client) cancelRequest(reqID string, startTime time.Time, promptTokens, completionTokens int, ttftDur *time.Duration) {
	totalDur := time.Since(startTime)
	totalNs := totalDur.Nanoseconds()
	now := time.Now().UTC()

	c.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
		rec.Status = "cancelled"
		rec.HTTPStatus = 499
		rec.CompletedAt = &now
		events.FinalizeTimings(rec, nil, ttftDur, &totalDur, nil, promptTokens, completionTokens, nil)
	})
	c.hub.Emit(reqID, events.EventRequestCancelled, "observer-api", "observer-api",
		"Client cancelled in-flight inference request; upstream context aborted",
		events.ObservationObserved, &totalNs, map[string]any{
			"tokens_before_cancel": completionTokens,
		})
	if rec, ok := c.hub.GetRequest(reqID); ok {
		c.metrics.RecordCompletion("cancelled", rec.Timings.TTFTMs.Value, nil, rec.Timings.TotalDurationMs.Value, nil, promptTokens, completionTokens)
	}
}

func (c *Client) failRequest(reqID string, startTime time.Time, statusCode int, errMsg string, routedToUpstream bool, selectedEndpoint string, w http.ResponseWriter, streamToClient bool) {
	totalDur := time.Since(startTime)
	totalNs := totalDur.Nanoseconds()
	now := time.Now().UTC()
	cleanMsg := redact.ScrubString(errMsg)

	failureScope := "rejected_prerouting"
	if routedToUpstream {
		failureScope = "routed_upstream_error"
	}

	c.hub.UpdateRequest(reqID, func(rec *events.RequestRecord) {
		rec.Status = "failed"
		rec.HTTPStatus = statusCode
		rec.FailureScope = failureScope
		if selectedEndpoint != "" {
			rec.SelectedEndpoint = selectedEndpoint
		}
		rec.ErrorMessage = cleanMsg
		rec.CompletedAt = &now
		events.FinalizeTimings(rec, nil, nil, &totalDur, nil, 0, 0, nil)
	})

	c.hub.Emit(reqID, events.EventRequestFailed, "observer-api", "gateway-proxy",
		cleanMsg,
		events.ObservationObserved, &totalNs, map[string]any{
			"http_status":       statusCode,
			"failure_scope":     failureScope,
			"selected_endpoint": selectedEndpoint,
		})
	c.metrics.RecordFailure(routedToUpstream)

	if w != nil {
		if streamToClient {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(statusCode)
			errPayload, _ := json.Marshal(map[string]any{
				"error": map[string]any{
					"message":    cleanMsg,
					"type":       "upstream_error",
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
		w.WriteHeader(statusCode)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message":    cleanMsg,
				"type":       "upstream_error",
				"request_id": reqID,
			},
		})
	}
}

func nonEmpty(val, fallback string) string {
	if strings.TrimSpace(val) != "" {
		return val
	}
	return fallback
}

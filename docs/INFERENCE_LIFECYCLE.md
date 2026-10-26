# Inference Lifecycle & Event Data Model

## 1. Ten-Stage Inference Lifecycle

The Observatory tracks an OpenAI-compatible inference request across 10 distinct stages:

1. **Prompt Submission** — Browser sends `POST /api/infer/stream` (or `POST /api/infer`) with `model`, `prompt`/`messages`, `max_tokens`, `temperature`, `router_mode`, and `priority_band`.
2. **Request Acceptance & Correlation (`request.accepted`)** — Observer API validates the payload, assigns `request_id` (`req_...`), starts an OpenTelemetry span (`traceparent`), and records a SHA-256 prefix summary of the prompt without logging raw prompt text.
3. **Gateway / Proxy Forwarding (`gateway.forwarded`)** — Observer API dispatches `POST /v1/chat/completions` to the `llm-d` Envoy sidecar (`:8081`).
4. **Queueing & Admission Control (`queue.observed`)** — Emitted only when `llm-d` Flow Control admission buffering or HTTP `429` saturation rejection (`x-llm-d-request-dropped-reason: rejected-saturated`) is observed.
5. **Endpoint Picker Filtering & Scoring (`routing.started`, `endpoint.selected`)** — Emitted when EPP response headers (`x-went-into-resp-headers`, `x-gateway-destination-endpoint`) or EPP trace spans are observed.
6. **Model Server Arrival (`model.request.started`)** — Emitted when HTTP `200 OK` response headers arrive from the upstream vLLM CPU model server (`UpstreamHeadersMs`).
7. **Prompt Processing / Prefill** — Tracked via `timings.prefill_duration_ms`. Because HTTP streaming does not emit a separate prefill-complete frame before the first decode step, `prefill_duration_ms` remains `unavailable` unless a dedicated model-server prefill span is exported. **It is never inferred from TTFT alone.**
8. **First Generated Text Token (`model.first_token`)** — **True TTFT (`TTFTMs`)**: recorded when the first non-empty `choices[0].delta.content` chunk arrives at the Observer API. Initial metadata-only chunks (`{"role":"assistant","content":""}`) are explicitly ignored.
9. **Autoregressive Token Streaming (`model.token`, `model.stream.completed`)** — Emitted for each subsequent streamed token with measured Inter-Token Latency (`itl_ms`), concluding when `data: [DONE]` arrives.
10. **Completion, Cancellation, Failure & Trace Enrichment (`request.completed`, `request.cancelled`, `request.failed`, `trace.enriched`)** — Finalizes per-request timings and asynchronously attaches correlated Jaeger trace spans.

---

## 2. Event Envelope Schema (`schema_version: "1"`)

Every event emitted over `GET /api/requests/{request_id}/events` (SSE or JSON) adheres to the `EventEnvelope` contract in [model.go](file:///Users/enes/GitHub/llm-d-inference-observatory/backend/observer/internal/events/model.go):

```json
{
  "schema_version": "1",
  "request_id": "req_38f88795939c4533",
  "trace_id": "0af7651916cd43dd8448eb211c80319c",
  "event_id": "evt_91a2b3c4_001",
  "sequence": 1,
  "event_type": "request.accepted",
  "source": "observer-api",
  "source_timestamp": "2026-10-26T20:27:47.120411Z",
  "observation_kind": "observed",
  "component": "observer-api",
  "message": "Request accepted by Observer API; request_id and W3C trace context assigned",
  "duration_ns": 0,
  "attributes": {
    "model": "Qwen/Qwen2.5-0.5B-Instruct",
    "router_mode": "optimized-baseline",
    "priority_band": "standard-traffic",
    "stream": true
  }
}
```

---

## 3. Observer API HTTP Contract

| Endpoint | Method | Format | Description |
| :--- | :--- | :--- | :--- |
| `/api/infer` | `POST` | JSON or SSE | Forwards chat completion request (streams if `stream: true`). |
| `/api/infer/stream` | `POST` | SSE (`text/event-stream`) | Forces streaming OpenAI chat completion response. |
| `/api/requests` | `GET` | JSON | Lists recent retained `RequestRecord` summaries. |
| `/api/requests/{request_id}` | `GET` | JSON | Returns full `RequestRecord` including timings, events, trace, and topology state. |
| `/api/requests/{request_id}/events` | `GET` | SSE or JSON | Streams live `EventEnvelope` items when `Accept: text/event-stream` or `?stream=true`. |
| `/api/requests/{request_id}/trace` | `GET` | JSON | Returns correlated `TraceRecord` and `SpanNode` hierarchy. |
| `/api/metrics` | `GET` | JSON or Prometheus | Returns `MetricsSummary` JSON (or Prometheus exposition if `?format=prometheus`). |
| `/metrics` | `GET` | Prometheus text | Exposes Observer API application counters and gauges. |
| `/api/config` | `GET` | JSON | Exposes safe runtime configuration (`mock_mode`, `allowed_models`, `router_modes`). |
| `/healthz`, `/readyz`, `/version` | `GET` | JSON | Liveness, readiness, and version metadata endpoints. |

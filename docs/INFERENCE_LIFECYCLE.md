# Inference Lifecycle & Event Data Model

## 1. Ten-Stage Inference Lifecycle

The Observatory tracks an OpenAI-compatible inference request across 10 distinct stages:

1. **Prompt Submission** — Browser sends `POST /api/infer/stream` (or `POST /api/infer`) with `model`, `prompt`/`messages`, `max_tokens`, `temperature`, `router_mode`, and `priority_band`.
2. **Request Acceptance & Correlation (`request.accepted`)** — Observer API validates the payload, assigns `request_id` (`req_...`), starts an OpenTelemetry span (`traceparent`), and records a SHA-256 prefix summary of the prompt without logging raw prompt text.
3. **Gateway / Proxy Forwarding (`gateway.forwarded`)** — Observer API dispatches `POST /v1/chat/completions` (injecting `"stream_options": {"include_usage": true}` when streaming) to the `llm-d` Envoy sidecar (`:8081`).
4. **Queueing & Admission Control (`queue.observed`)** — Emitted when `llm-d` Flow Control admission buffering or HTTP `429` saturation rejection (`x-llm-d-request-dropped-reason: rejected-saturated`) is observed.
5. **Endpoint Picker Filtering & Scoring (`routing.started`, `endpoint.selected`)** — Emitted when EPP response headers (`x-went-into-resp-headers`, `x-gateway-destination-endpoint`) or EPP trace spans are observed. The winning pod (`selected_endpoint`) is resolved from `x-gateway-destination-endpoint` (`<pod_ip>:8000`) and kept strictly separate from candidate rankings (`candidate_endpoints`).
6. **Model Server Arrival (`model.request.started`)** — Emitted when HTTP `200 OK` response headers arrive from the upstream vLLM CPU model server (`UpstreamHeadersMs`).
7. **Prompt Processing / Prefill** — Tracked via `timings.prefill_duration_ms`. Because HTTP streaming does not emit a separate prefill-complete frame before the first decode step, `prefill_duration_ms` remains `unavailable` unless a dedicated model-server prefill span is exported. **It is never inferred from TTFT alone.**
8. **First Generated Text Token (`model.first_token`)** — **True TTFT (`TTFTMs`)**: recorded when the first non-empty `choices[0].delta.content` chunk arrives at the Observer API. Initial metadata-only chunks (`{"role":"assistant","content":""}`) are explicitly ignored.
9. **Autoregressive Token Streaming (`model.token`, `model.stream.completed`)** — Emitted for each subsequent streamed token with measured Inter-Token Latency (`itl_ms`), concluding when the final usage chunk (`usage.prompt_tokens`, `usage.completion_tokens`) and `data: [DONE]` arrive.
10. **Completion, Cancellation, Failure & Trace Enrichment (`request.completed`, `request.cancelled`, `request.failed`, `trace.enriched`)** — Finalizes per-request timings and asynchronously attaches correlated Jaeger trace spans (`observer.infer` + EPP child spans).

---

## 2. Event Envelope Schema (`schema_version: "1"`)

Every event emitted over `GET /api/requests/{request_id}/events` (SSE or JSON) adheres to the [`EventEnvelope`](../backend/observer/internal/events/model.go#L41-L58) contract:

```json
{
  "schema_version": "1",
  "request_id": "req_691385da5c3746f6",
  "trace_id": "13f294861832db61f89b1c0c481f7ae9",
  "event_id": "evt_req_691385da5c3746f6_004",
  "sequence": 4,
  "event_type": "endpoint.selected",
  "source": "llm-d-router-epp",
  "source_timestamp": "2026-10-26T23:28:55.104821Z",
  "observation_kind": "observed",
  "component": "inference-pool",
  "message": "EPP selected model server endpoint llm-d-observatory/experimental-small-vllm-decode-6c9bdb656c-hlbrc (10.20.1.14:8000)",
  "duration_ns": 0,
  "attributes": {
    "selected_endpoint": "llm-d-observatory/experimental-small-vllm-decode-6c9bdb656c-hlbrc (10.20.1.14:8000)",
    "x-gateway-destination-endpoint": "10.20.1.14:8000"
  }
}
```

---

## 3. RequestRecord Timings & Provenance Fields

Each [`RequestRecord`](../backend/observer/internal/events/model.go#L117-L141) returned by `GET /api/requests/{request_id}` includes explicit timing and token provenance fields:

| Field | Type / Classification | Description |
| :--- | :--- | :--- |
| `selected_endpoint` | `string` (`observed`) | Authoritative winning pod resolved from `x-gateway-destination-endpoint` (`<pod_ip>:8000`). |
| `candidate_endpoints` | `string[]` (`observed`) | Ranked candidate pods from EPP's `pick_endpoints` span (`llm_d.epp.picker.top_endpoints`). |
| `timings.upstream_headers_ms` | `ObservedValue` (`measured`) | Time from upstream request dispatch until HTTP response headers arrive. |
| `timings.ttft_ms` | `ObservedValue` (`measured`) | **True TTFT** — time until the first non-empty content delta arrives at Observer API. |
| `timings.prefill_duration_ms` | `ObservedValue` (`unavailable`) | Model-server prefill duration; `unavailable` unless a dedicated prefill span exists. |
| `timings.total_duration_ms` | `ObservedValue` (`measured`) | End-to-end request duration from acceptance to stream completion. |
| `timings.mean_itl_ms` / `p95_itl_ms` | `ObservedValue` (`derived`) | Mean and 95th percentile Inter-Token Latency across generated tokens `2..N`. |
| `timings.decode_tokens_per_sec` | `ObservedValue` (`derived`) | Autoregressive decode speed after the first token (`(N-1) / (Total - TTFT)`). |
| `timings.prompt_tokens_source` | `string` | `vllm_usage` (exact subword count from vLLM) or `observer_char_estimate` (fallback). |
| `timings.completion_tokens_source` | `string` | `vllm_usage` (exact subword count from vLLM) or `sse_chunk_count` (fallback). |
| `timings.epp_token_count` / `epp_token_backend` | `int` / `string` | Token count produced by EPP's `tokenize` span (`backend="vllm"` or `"estimate"`). |

---

## 4. Observer API HTTP Contract

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

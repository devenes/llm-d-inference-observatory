# Observability: OpenTelemetry Tracing & Prometheus Metrics

## 1. Filling the Reference Tracing Gap

During Phase 0 inspection of `/Users/enes/GitHub/llm-d-gke-cpu-lab`, we verified that `deploy/llm-d/base.values.yaml` included `router.tracing.otelExporterEndpoint: "http://localhost:4317"`, but omitted `router.tracing.enabled: true`. Inspecting the upstream Helm chart template (`charts/router/templates/_deployment.yaml` in `llm-d-router-standalone:v1.0.0`) revealed:

```yaml
{{- if .Values.router.tracing.enabled }}
    - --tracing=true
{{- else }}
    - --tracing=false
{{- end }}
```

In `llm-d-inference-observatory`, [base.values.yaml](file:///Users/enes/GitHub/llm-d-inference-observatory/deploy/llm-d/base.values.yaml) explicitly sets:

```yaml
router:
  tracing:
    enabled: true
    otelExporterEndpoint: "http://otel-collector.llm-d-observatory.svc.cluster.local:4317"
    sampling:
      sampler: "parentbased_traceidratio"
      samplerArg: "1.0"
```

And in [deploy-gke.sh](file:///Users/enes/GitHub/llm-d-inference-observatory/scripts/deploy-gke.sh), `OTEL_BSP_SCHEDULE_DELAY=200` is configured on the `epp` container of `deployment/llm-d-router-epp` so that OpenTelemetry `BatchSpanProcessor` flushes spans every `200 ms` instead of the Go SDK default (`5000 ms`).

> [!NOTE]
> **Upstream `vllm-openai-cpu:v0.31.0` OTel Image Constraint:**
> The upstream `docker.io/vllm/vllm-openai-cpu:v0.31.0` container image does not bundle Python `opentelemetry-sdk` packages (`otlp_traces_endpoint=None`), so passing `--otlp-traces-endpoint` causes `vllm serve` to exit at startup. Consequently, per-request distributed spans are emitted by `observer-api` (`observer.infer`) and `llm-d-router/epp` (`9`–`11` child spans per request: `request`, `request_orchestration`, `tokenize`, `run_scheduler_profile`, `filter_endpoints`, `filter_prefix_cache_affinity`, `scoring`, `scorer.token-load-scorer` / `scorer.queue-scorer`, and `pick_endpoints`), while model-server metrics (`vllm:*`) are scraped via Prometheus across all headless service Pod IPs and `prefill_duration_ms` is honestly reported as `unavailable`.

---

## 2. OpenTelemetry Collector Pipeline & Redaction

Deployed via [otel-collector.yaml](file:///Users/enes/GitHub/llm-d-inference-observatory/deploy/telemetry/otel-collector.yaml), the collector:

1. Receives OTLP spans over gRPC (`:4317`) and HTTP (`:4318`).
2. Applies `memory_limiter` (`256 MiB`) and attaches Kubernetes resource labels (`k8s.cluster.name: llm-d-observatory`, `k8s.namespace.name: llm-d-observatory`).
3. Runs `attributes/redact` processor to delete `gen_ai.prompt`, `gen_ai.completion`, `llm.prompts`, `llm.completions`, `prompt`, and `authorization` attributes so raw user text and tokens are never stored in Jaeger.
4. Batches and exports spans to `jaeger-collector.llm-d-observatory.svc.cluster.local:4317`.

---

## 3. Asynchronous Trace Enrichment

Because OpenTelemetry SDKs batch spans before flushing to the Collector and Jaeger, spans frequently become queryable `100–400 ms` after the final SSE token has already been delivered to the browser.

- The Observer API **never delays the token stream** to wait for Jaeger.
- Instead, `enrichTraceAsync` in [client.go](file:///Users/enes/GitHub/llm-d-inference-observatory/backend/observer/internal/upstream/client.go) queries `GET /api/traces/{trace_id}` asynchronously after `request.completed` and emits a `trace.enriched` SSE event when spans arrive.
- If Jaeger is unreachable or returns only partial spans (e.g., Observer + EPP without vLLM), the UI displays `status: "partial"` or `status: "unavailable"` with a clear explanation.

---

## 4. Prometheus Metrics & RBAC Authentication

| Target | Endpoint | Auth | Key Exposed Metrics |
| :--- | :--- | :--- | :--- |
| **Observer API** | `:8080/metrics` | Cluster-internal | `observer_requests_total`, `observer_requests_failed_by_scope_total`, `observer_requests_in_flight`, `observer_prompt_tokens_total`, `observer_generation_tokens_total`, `observer_ttft_p50_milliseconds` |
| **llm-d EPP** | `:9090/metrics` | Kubernetes RBAC Bearer Token (`ClusterRole/llm-d-observatory-metrics-reader`) | `llm_d_epp_ready_endpoints`, `llm_d_epp_request_total`, `llm_d_epp_request_error_total`, `llm_d_epp_kv_cache_index_lookup_hits_total`, `llm_d_epp_prefix_predicted_cached_tokens_sum`, `llm_d_epp_flow_control_queue_size`, `llm_d_epp_flow_control_pool_saturation` |
| **vLLM CPU Server** | `:8000/metrics` | Unauthenticated HTTP | `vllm:num_requests_running`, `vllm:num_requests_waiting`, `vllm:prefix_cache_queries_total`, `vllm:prefix_cache_hits_total`, `vllm:time_to_first_token_seconds_{bucket,sum,count}` |

---

## 5. Telemetry Integrity & Reconciliation Rules

### 5.1 Genuine Zero Values vs. Missing Series (`llm_d_epp_flow_control_*` & `llm_d_epp_kv_cache_index_*`)
- **Plugin & Feature Gate Activation:**
  - `llm_d_epp_flow_control_queue_size` and `llm_d_epp_flow_control_pool_saturation` require `featureGates: [flowControl]` and `flowControl:` (`concurrency-detector`) in `EndpointPickerConfig`.
  - `llm_d_epp_kv_cache_index_lookup_hits_total` requires `precise-prefix-cache-producer` with `indexerConfig.kvBlockIndexConfig.enableMetrics: true`, `endpoint-notification-source`, and `dataLayer` configured in `EndpointPickerConfig`.
  - Both vLLM (`--block-size=64`) and EPP (`blockSizeTokens: 64`) index KV cache in **64-token blocks**; prompts shorter than 64 tokens produce `0` block lookups.
- **Prometheus `CounterVec` / `GaugeVec` Semantics & Stage Filtering:**
  - In Go `client_golang`, vector metrics only emit sample lines after their label vector is first initialized. In [metrics.go](file:///Users/enes/GitHub/llm-d-inference-observatory/backend/observer/internal/telemetry/metrics.go), when the EPP `:9090/metrics` scrape succeeds and the corresponding subsystem (`flowControl` or `precise-prefix-cache-producer`) is active, an uninitialized or zero vector is reported as a **genuine `0` (`observation_kind: "aggregate"`)** rather than `unavailable`. If the scrape fails or the subsystem is disabled, the series is reported as **`unavailable` (`value: null`)**.
  - `llm_d_epp_flow_control_pool_saturation` emits both `stage="decode"` and `stage="effective"`; the scraper filters `stage="effective"` so pool saturation is not double-counted.

### 5.2 Request Counter Reconciliation (`Observer` vs. `EPP`)
- **`llm_d_epp_request_total`** is incremented by EPP during response handling for every request **scheduled and routed to a model server**, including requests where the upstream model server returns HTTP `4xx`/`5xx` (which also increment `llm_d_epp_request_error_total{error_code="ModelServerError"}`).
- **Pre-routing rejections** (such as HTTP `429` `rejected-saturated` or HTTP `503` `ServiceUnavailable` when `0` endpoints are ready) are rejected by EPP before routing to a pod; they increment `observer_requests_rejected_prerouting_total` and `llm_d_epp_request_error_total`, and do **not** increment `llm_d_epp_request_total`.
- Therefore, for traffic flowing through Observer API:
  $$\texttt{observer\_requests\_completed\_total} + \texttt{observer\_requests\_upstream\_error\_total} = \texttt{llm\_d\_epp\_request\_total}$$
  $$\texttt{observer\_requests\_failed\_total} = \texttt{observer\_requests\_upstream\_error\_total} + \texttt{observer\_requests\_rejected\_prerouting\_total} = \texttt{llm\_d\_epp\_request\_error\_total}$$
- Direct in-cluster test probes sent straight to `svc/llm-d-router-epp:80` increment EPP counters without incrementing Observer API counters.

### 5.3 Token-Count Provenance (`vllm_usage` vs. `EPP tokenize` vs. `observer_char_estimate`)
- **Observer / vLLM Usage (`vllm_usage`):** [client.go](file:///Users/enes/GitHub/llm-d-inference-observatory/backend/observer/internal/upstream/client.go) sends `"stream_options": {"include_usage": true}` on streaming requests (`stream: true`) so `vLLM` emits exact subword `usage.prompt_tokens` and `usage.completion_tokens` (including ChatML system/user/assistant framing tokens) in the final SSE chunk.
- **EPP Token Producer (`epp_token_count` / `epp_token_backend`):** Extracted from the `tokenize` OpenTelemetry span (`llm_d.epp.token_producer.token_count` and `llm_d.epp.token_producer.backend`). When `token-producer` is configured with `vllm.endpointDiscovery`, EPP calls vLLM's `/v1/chat/completions/render` endpoint (`backend="vllm"`); otherwise it uses EPP's message estimator (`backend="estimate"`).
- **Observer Fallback Estimate (`observer_char_estimate`):** Only used if an upstream response omits `usage` (e.g., cancelled or failed before completion), computed as `(chars + 3) / 4` on the raw user prompt text.

### 5.4 Selected Endpoint Visibility (Never Inferred from Candidate Rankings)
- Envoy (`ConfigMap/envoy`) echoes the EPP-assigned `x-gateway-destination-endpoint` (`<pod_ip>:8000`) in the HTTP response headers on the scheduled route (`original_destination_cluster`).
- [client.go](file:///Users/enes/GitHub/llm-d-inference-observatory/backend/observer/internal/upstream/client.go) reads `x-gateway-destination-endpoint`, resolves `<pod_ip>:8000` to the Kubernetes pod name (`llm-d-observatory/<pod_name> (<pod_ip>:8000)`), records `llm_d.selected_endpoint` and `x-gateway-destination-endpoint` on the `observer.infer` OpenTelemetry span, and populates `rec.SelectedEndpoint`, `endpoint.selected`, and `rec.Topology`.
- `ExtractEndpointFromSpans` **never** infers the selected endpoint from `llm_d.epp.picker.top_endpoints` candidate rankings; candidate rankings are extracted separately into `rec.CandidateEndpoints`.

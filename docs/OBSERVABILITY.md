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
| **Observer API** | `:8080/metrics` | Cluster-internal | `observer_requests_total`, `observer_requests_in_flight`, `observer_prompt_tokens_total`, `observer_generation_tokens_total`, `observer_ttft_p50_milliseconds` |
| **llm-d EPP** | `:9090/metrics` | Kubernetes RBAC Bearer Token (`ClusterRole/llm-d-observatory-metrics-reader`) | `llm_d_epp_ready_endpoints`, `llm_d_epp_request_total`, `llm_d_epp_kv_cache_index_lookup_hits_total`, `llm_d_epp_prefix_predicted_cached_tokens_sum`, `llm_d_epp_flow_control_queue_size`, `llm_d_epp_flow_control_pool_saturation` |
| **vLLM CPU Server** | `:8000/metrics` | Unauthenticated HTTP | `vllm:num_requests_running`, `vllm:num_requests_waiting`, `vllm:prefix_cache_queries_total`, `vllm:prefix_cache_hits_total`, `vllm:time_to_first_token_seconds_{bucket,sum,count}` |

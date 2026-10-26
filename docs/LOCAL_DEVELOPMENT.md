# Local Development & Mock Mode Guide

`llm-d-inference-observatory` includes a deterministic local demo mode (`OBSERVER_MOCK_MODE=true`) and a Docker Compose workflow that exercise the entire UI, SSE lifecycle pipeline, Interactive Topology visualizer, and benchmark harness without requiring a live Kubernetes cluster.

---

## 1. Option A — Local Hot-Reload Development (`make dev`)

```bash
make dev
```

- Starts the Go Observer API on `http://localhost:8080` with `OBSERVER_MOCK_MODE=true`.
- Starts the Vite React development server on `http://localhost:5173` (proxying `/api/*` to `:8080`).

### Honest Simulation Guarantees

- Every event, timing, and span produced when `OBSERVER_MOCK_MODE=true` is tagged with `"observation_kind": "simulated"` and prefixed with `[SIMULATED]`.
- A prominent amber banner (`LOCAL DEMO / MOCK MODE ACTIVE`) is rendered at the top of the UI.
- Production Kubernetes manifests ([`observer-api.yaml`](file:///Users/enes/GitHub/llm-d-inference-observatory/deploy/observatory/observer-api.yaml)) hardcode `OBSERVER_MOCK_MODE: "false"` and are verified by `./scripts/validate-manifests.sh` so mock mode can never silently substitute for a real upstream in GKE deployments.

---

## 2. Option B — Local Docker Compose Stack (`docker compose`)

To run the production multi-stage containers (`observer-api` + `nginx` frontend) locally via Docker Compose:

```bash
# Build and start both containers in detached mode
docker compose up -d --build

# Open http://localhost:8088 in your browser
open http://localhost:8088

# Or run the automated Docker Compose smoke test (builds, verifies health & /api/infer, and tears down)
make compose-smoke
```

| Container | Host Port | Container Port | Description |
| :--- | :--- | :--- | :--- |
| `frontend` | `http://localhost:8088` | `:8080` | Unprivileged Nginx serving the production React bundle and proxying `/api/*` to `observer-api:8080`. |
| `observer-api` | `http://localhost:8080` | `:8080` | Distroless non-root Go binary running in `OBSERVER_MOCK_MODE=true`. |

---

## 3. Supported Local Mock Scenarios

Select any of the following scenarios in the **Inference Playground** (`Simulated Scenario` dropdown) or pass `"scenario"` in the JSON request body:

| Scenario | Behavior Exercised |
| :--- | :--- |
| `success` | Full lifecycle (`request.accepted` → `gateway.forwarded` → `routing.started` → `endpoint.selected` → `model.request.started` → initial empty role chunk → `model.first_token` → `model.token` → `model.stream.completed` → `request.completed` → `trace.enriched`). |
| `delay` | Simulates slow prompt prefill / cold CPU kernel compilation (`180 ms` prefill wait + `45 ms` ITL). |
| `saturated` | Simulates `llm-d` Flow Control overload shedding (`queue.observed` + `request.failed` with HTTP `429 Too Many Requests` and `x-llm-d-request-dropped-reason: rejected-saturated`). |
| `cancel` | Streams tokens at a controlled pace (`40` tokens at `45 ms` intervals) so browser `Cancel` or CLI `--cancel-after-ms` deterministically aborts the request mid-stream (`request.cancelled`). |
| `partial_trace` | Completes the request with `trace.status = "partial"` (Observer API + Envoy + EPP spans present, vLLM model-server span omitted, and `prefill_duration_ms` marked `unavailable`). |
| `delayed_trace` | Completes the SSE token stream immediately while `trace.enriched` arrives `350 ms` later out-of-band. |
| `missing_metrics` | Simulates unreachable upstream Prometheus endpoints (`epp_scrape_status = "missing_simulated"`, `observation_kind = "unavailable"`). |

---

## 4. Environment Variables Reference

All runtime settings are validated in [`config.go`](file:///Users/enes/GitHub/llm-d-inference-observatory/backend/observer/internal/config/config.go):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `OBSERVER_LISTEN_ADDR` | `:8080` | HTTP bind address for Observer API. |
| `OBSERVER_MOCK_MODE` | `false` | Enables local deterministic simulator when `true`. |
| `OBSERVER_UPSTREAM_URL` | `http://llm-d-router-epp.llm-d-observatory.svc.cluster.local:80` | Target `llm-d` router base URL. |
| `OBSERVER_ALLOWED_UPSTREAM_HOSTS` | `localhost,127.0.0.1,llm-d-router-epp,...` | Comma-separated SSRF host allowlist. |
| `OBSERVER_ALLOWED_MODELS` | `Qwen/Qwen2.5-0.5B-Instruct` | Comma-separated permitted model identifiers. |
| `OBSERVER_DEFAULT_MODEL` | `Qwen/Qwen2.5-0.5B-Instruct` | Default model when omitted in request payload. |
| `OBSERVER_ROUTER_MODE` | `optimized-baseline` | Default active router profile label. |
| `OBSERVER_REDACT_PROMPTS` | `true` | Redacts raw prompts and completions from logs and span attributes. |
| `OBSERVER_MAX_BODY_BYTES` | `65536` | Maximum request payload size (`64 KiB`). |
| `OBSERVER_MAX_OUTPUT_TOKENS` | `1024` | Maximum allowed `max_tokens` per request. |
| `OBSERVER_MAX_CONCURRENT_REQUESTS` | `16` | In-flight request concurrency limit. |
| `OBSERVER_REQUEST_TIMEOUT` | `120s` | Per-request upstream timeout. |
| `OBSERVER_TRACE_QUERY_TIMEOUT` | `4s` | Timeout for asynchronous Jaeger `/api/traces/{id}` queries. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `""` | OTLP HTTP/gRPC collector endpoint for `observer.infer` spans. |
| `OBSERVER_JAEGER_QUERY_URL` | `http://jaeger-query.llm-d-observatory.svc.cluster.local:16686` | Jaeger Query API base URL. |
| `OBSERVER_EPP_METRICS_URL` | `http://llm-d-router-epp.llm-d-observatory.svc.cluster.local:9090/metrics` | EPP Prometheus metrics endpoint. |
| `OBSERVER_VLLM_METRICS_URL` | `http://llm-d-router-epp-model-servers.llm-d-observatory.svc.cluster.local:8000/metrics` | Headless service URL used to discover and scrape all vLLM pod IPs. |

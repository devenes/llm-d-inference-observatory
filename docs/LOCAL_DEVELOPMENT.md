# Local Development & Mock Mode Guide

Because cloud infrastructure is not created during the preparation phase, `llm-d-inference-observatory` includes a deterministic local demo mode (`OBSERVER_MOCK_MODE=true`) that exercises the entire UI, SSE lifecycle pipeline, topology visualizer, and benchmark harness without a Kubernetes cluster.

---

## 1. Running Local Demo Mode

```bash
make dev
```

- Starts the Go Observer API on `http://localhost:8080` with `OBSERVER_MOCK_MODE=true`.
- Starts the Vite React development server on `http://localhost:5173` (proxying `/api/*` to `:8080`).

### Honest Simulation Guarantees

- Every event, timing, and span produced when `OBSERVER_MOCK_MODE=true` is tagged with `"observation_kind": "simulated"` and prefixed with `[SIMULATED]`.
- A prominent amber banner (`LOCAL DEMO / MOCK MODE ACTIVE`) is rendered at the top of the UI.
- Production Kubernetes manifests ([observer-api.yaml](file:///Users/enes/GitHub/llm-d-inference-observatory/deploy/observatory/observer-api.yaml)) hardcode `OBSERVER_MOCK_MODE: "false"` and are verified by `./scripts/validate-manifests.sh` so mock mode can never silently substitute for a real upstream in GKE deployments.

---

## 2. Supported Local Mock Scenarios

Select any of the following scenarios in the **Inference Playground** (`Simulated Demo Scenario` dropdown) or pass `"scenario"` in the JSON request body:

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

## 3. Environment Variables Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `OBSERVER_LISTEN_ADDR` | `:8080` | HTTP bind address for Observer API. |
| `OBSERVER_MOCK_MODE` | `false` | Enables local deterministic simulator when `true`. |
| `OBSERVER_UPSTREAM_URL` | `http://llm-d-router-epp.llm-d-observatory.svc.cluster.local:80` | Target `llm-d` router base URL. |
| `OBSERVER_ALLOWED_UPSTREAM_HOSTS` | `localhost,127.0.0.1,llm-d-router-epp,...` | Comma-separated SSRF host allowlist. |
| `OBSERVER_ALLOWED_MODELS` | `Qwen/Qwen2.5-0.5B-Instruct,meta-llama/Llama-3.2-3B-Instruct` | Permitted model identifiers. |
| `OBSERVER_REDACT_PROMPTS` | `true` | Redacts raw prompts and completions from logs and span attributes. |
| `OBSERVER_MAX_BODY_BYTES` | `65536` | Maximum request payload size (`64 KiB`). |
| `OBSERVER_MAX_OUTPUT_TOKENS` | `1024` | Maximum allowed `max_tokens` per request. |
| `OBSERVER_MAX_CONCURRENT_REQUESTS` | `16` | In-flight request concurrency limit. |
| `OBSERVER_REQUEST_TIMEOUT` | `120s` | Per-request upstream timeout. |

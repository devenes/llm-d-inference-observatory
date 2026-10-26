# Testing & Validation Guide

## 1. Validation Provenance & Live GKE Verification (`L01`–`L14`)

> [!IMPORTANT]
> **Both Local and Live GKE Validation Executed (`2026-10-27`):**
> Every test artifact in [`artifacts/test-results/`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/) and [`artifacts/benchmarks/`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/benchmarks/) explicitly labels whether it was recorded against the deterministic local simulator (`OBSERVER_MOCK_MODE=true`) or the live CPU-only GKE cluster (`llm-d-observatory` in `us-west4-a`, GKE `v1.36.4-gke.2046003`, `OBSERVER_MOCK_MODE=false`).

### Live GKE Verification Matrix (`L01`–`L14`)

Full summary artifact: [`artifacts/test-results/live-gke-matrix-summary-2026-10-27.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/live-gke-matrix-summary-2026-10-27.json)

| ID | Scenario | Status | Evidence Artifact | Summary of Live GKE Result |
| :--- | :--- | :--- | :--- | :--- |
| **L01** | Basic live inference | **PASS** | [`L01-basic-inference.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L01-basic-inference.json) | Real prompt routed via Envoy/EPP to `vLLM` CPU (`Qwen/Qwen2.5-0.5B-Instruct`), HTTP `200`, `10` OTel spans (`observer.infer` + `9` EPP child spans). |
| **L02** | Live streaming | **PASS** | [`L01-L04-live-results.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L01-L04-live-results.json) | SSE streaming (`req_44041d5a6f3f4f60`): True TTFT `32.72 ms`, Mean ITL `26.66 ms`, `36` token chunks, `prefill_duration_ms` = `unavailable`. |
| **L03** | Event & trace correlation | **PASS** | [`L01-L04-live-results.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L01-L04-live-results.json) | `100%` `request_id` and W3C `trace_id` correlation across Observer API events and Jaeger spans (`observer-api` + `llm-d-router/epp`). |
| **L04** | EPP routing observation | **PASS** | [`L01-L04-live-results.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L01-L04-live-results.json) | Observed real EPP spans: `filter_endpoints` (`2 -> 2`), `filter_prefix_cache_affinity`, `scorer.token-load-scorer`, `pick_endpoints` (`llm_d.epp.picker.top_endpoints`). |
| **L05** | Long vs. short prompt | **PASS** | [`L05-prompt-length-comparison.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L05-prompt-length-comparison.json) | Short prompt TTFT `30.38 ms` vs. long prompt TTFT `38.45 ms`; `vllm:prompt_tokens_total` `1072 -> 1109 -> 1502`; `prefill_duration_ms` remains `unavailable`. |
| **L06** | Long generation (`96` tok) | **PASS** | [`L06-long-generation-streaming.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L06-long-generation-streaming.json) | 96-token stream (`req_d6ebde2328ca4e14`): True TTFT `30.89 ms`, Mean ITL `27.83 ms`, p95 ITL `53.13 ms`, Decode throughput `35.94 tok/s`. |
| **L07** | Concurrency & Flow Control | **PASS** | [`L07-flow-control-queueing.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L07-flow-control-queueing.json) | 12-request burst (`router_mode=flow-control`): `llm_d_epp_flow_control_queue_size` peaked at `8`, saturation at `2.0`, `vllm:num_requests_running` capped at `4.0`. |
| **L08** | Multiple model replicas | **PASS** | [`L08-multi-replica-distribution.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L08-multi-replica-distribution.json) | 8 concurrent requests split `4.0` to `hlbrc` (`10.20.1.14`) and `4.0` to `sfm46` (`10.20.1.15`). |
| **L09** | Backend failure & recovery | **PASS** | [`L09-backend-failure-recovery.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L09-backend-failure-recovery.json) | Single-replica failover (`ready_endpoints=1`, HTTP `200`), 0-endpoint failure (HTTP `503`, `status=failed`), and label restoration recovery (`ready_endpoints=2`, HTTP `200`). |
| **L10** | Client cancellation | **PASS** | [`L10-client-cancellation.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L10-client-cancellation.json) | Mid-stream disconnect after 3 chunks transitioned `req_9678ff3828294f25` to `status=cancelled` and incremented `observer_requests_total{status="cancelled"}`. |
| **L11** | Live aggregate metrics | **PASS** | [`L11-live-metrics.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L11-live-metrics.json) | `epp_scrape_status=scraped` (`:9090` w/ RBAC bearer token), `vllm_scrape_status=scraped` (`:8000` headless DNS), `20` aggregate series. |
| **L12** | UI & local mode distinction | **PASS** | [`L12-live-ui-verification.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L12-live-ui-verification.json) | Playwright Chromium verification against `http://127.0.0.1:8088/` confirmed `0` mock banners, `0` simulated badges, and real token streaming (`req_7034617ff00641b3`). |
| **L13** | Performance benchmark | **PASS** | [`live-gke-benchmark-report.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/benchmarks/live-gke-benchmark-report.json) | `8/8` measured streaming requests (`concurrency=2`): TTFB p50 `201.01 ms`, True TTFT p50 `273.88 ms`, E2E p50 `1376.34 ms`, `22.18 tok/s`. |
| **L14** | Resource health | **PASS** | [`L14-resource-health.json`](file:///Users/enes/GitHub/llm-d-inference-observatory/artifacts/test-results/L14-resource-health.json) | All `8` Pods in `llm-d-observatory` `Running`/`Ready` with `0` restarts; all `3` Prometheus targets `up`. |

---

## 2. Running the Full Local Test Suite

Run all backend, frontend, manifest, and Terraform checks from the repository root:

```bash
make test
```

### 2.1 Go Backend Unit, Race & Integration Tests

Located in `backend/observer/`:
```bash
cd backend/observer
gofmt -s -w .
go vet ./...
go test -v -race ./...
```

Covered test suites:
- `internal/config/config_test.go`: Environment configuration parsing, upstream URL & SSRF host allowlist validation, model allowlist checks.
- `internal/redact/redact_test.go`: Prompt SHA-256 hashing (`prompt_sha256`, `prompt_chars`), sensitive attribute scrubbing (`Authorization`, `Bearer`, `sk-`, `hf_`), and preservation of numeric token counters (`prompt_tokens`, `completion_tokens`).
- `internal/events/hub_test.go`: `EventEnvelope` schema validation (`schema_version: "1"`), ring-buffer bounds, SSE pub/sub delivery, and strict check that `PrefillDurationMs` is never fabricated from `TTFTMs` alone.
- `internal/telemetry/telemetry_test.go`: OpenTelemetry W3C `traceparent` injection, Jaeger `/api/traces/{traceID}` parsing into normalized `TraceView` spans, and Prometheus text-exposition parsing for `llm_d_epp_*` and `vllm:*` metrics.
- `internal/server/server_test.go`:
  - Mock mode synchronous (`POST /api/infer`) and streaming (`POST /api/infer/stream`) lifecycle execution.
  - Real `UpstreamClient` streaming against a simulated OpenAI SSE server verifying **True TTFT** (ignoring the initial empty `role: "assistant", content: ""` chunk).
  - Prompt size (`max_prompt_chars`), `max_tokens`, disallowed model (`400`), and concurrency limit (`429`) enforcement.
  - Client cancellation propagation and `partial_trace` scenario handling.
- `internal/benchmark/runner_test.go`: Benchmark runner execution, warmup exclusion, percentile calculation (`p50`, `p95`, `p99`), and JSON/CSV artifact generation.

---

### 2.2 Frontend Typecheck, Lint & Unit/Component Tests (Vitest)

Located in `frontend/`:
```bash
cd frontend
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Covered component tests (`frontend/src/test/observatory.test.tsx`):
- Renders all 6 observation badges (`observed`, `measured`, `aggregate`, `derived`, `unavailable`, `simulated`) with icons, semantic colors, and tooltips.
- Renders the navigation bar, mode badge (`MOCK SIMULATOR`), and all 5 screens (`Playground`, `Timeline`, `Topology`, `Metrics`, `Learning Lab`).
- Verifies that `Timeline` displays an explicit `unavailable` state when `prefill_duration_ms` is not separately exposed by `vllm-openai-cpu:v0.31.0`.
- Verifies that `Learning Lab` renders all 7 required architectural topics, including explicit Kubernetes API Server vs. Inference Data Path distinction.

---

### 2.3 Playwright End-to-End Browser Tests

Located in `frontend/e2e/observatory.spec.ts`. Automatically starts both the Go Observer API (`:18080` in `OBSERVER_MOCK_MODE=true`) and Vite preview server (`:4173`):

```bash
cd frontend
pnpm test:e2e
```

Verified E2E scenarios:
1. **Prompt submission & live token streaming**: Submits a prompt in `Screen 1 — Inference Playground` and verifies live token assembly, request ID, trace ID, TTFT, and TPOT metrics.
2. **Request history & lifecycle timeline**: Inspects `Screen 2 — Request Lifecycle Timeline`, verifying stage durations, SSE event log inspection, and observation badges.
3. **Interactive topology**: Inspects `Screen 3 — Interactive Inference Topology` (`@xyflow/react`), clicks the `Endpoint Picker (EPP)` node, and verifies the detail drawer displays candidate pod scores (`prefix-cache-affinity-filter`, `load-aware-scorer`) and links to the Learning Lab.
4. **Partial trace & unavailable prefill honesty**: Runs the `partial_trace` fault scenario and verifies degraded trace banner and `unavailable` prefill badge.
5. **Saturation & admission queueing**: Runs the `saturated` scenario and verifies `request.queued` stage visibility.
6. **Stream cancellation**: Starts a `cancel` scenario stream, clicks `Cancel Stream`, and verifies `cancelled` status.
7. **Metrics & Architecture Learning Lab**: Verifies `Screen 4 — Metrics & Latency Explorer` and `Screen 5 — Architecture Learning Lab`.

---

### 2.4 Infrastructure & Manifest Validation

```bash
./scripts/tf-plan.sh
./scripts/render-manifests.sh
./scripts/validate-manifests.sh
```

- `tf-plan.sh`: Runs `terraform fmt -check`, `terraform init`, `terraform validate`, and `terraform plan` (outputs `artifacts/test-results/terraform-plan.txt`).
- `render-manifests.sh`: Renders `deploy/charts/llm-d-router-standalone-v1.0.0.tgz` across all 3 scheduler profiles (`baseline`, `precise-prefix-cache`, `flow-control`) into `deploy/rendered/`.
- `validate-manifests.sh`: Validates YAML syntax, required Kubernetes fields (`apiVersion`, `kind`, `metadata.name`), container security contexts, and verifies `--tracing=true` on the `llm-d` router across 65 Kubernetes resource documents (outputs `artifacts/test-results/manifest-validation.txt`).

---

### 2.5 Benchmark Harness Execution

Run the Go benchmark harness against the local mock simulator:
```bash
make benchmark-mock
```

Outputs:
- `artifacts/test-results/benchmark-mock-report.json`
- `artifacts/test-results/benchmark-mock-samples.csv`

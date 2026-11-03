# Testing, Validation & Performance Benchmark Guide

## 1. Validation Provenance & Live GKE Verification (`L01`–`L14` + Telemetry Issue Fixes)

> [!IMPORTANT]
> **Both Local and Live GKE Validation Executed (`2026-10-27`):**
> Every test artifact in [`artifacts/test-results/`](../artifacts/test-results/) and [`artifacts/benchmarks/`](../artifacts/benchmarks/) explicitly labels whether it was recorded against the deterministic local simulator (`OBSERVER_MOCK_MODE=true`) or the live CPU-only GKE cluster (`llm-d-observatory` in `us-west4-a`, GKE `v1.36.4-gke.2046003`, `OBSERVER_MOCK_MODE=false`).

### Live GKE Verification Matrix (`L01`–`L14`)

Full summary artifacts:
- [`artifacts/test-results/live-gke-matrix-summary-2026-10-27.json`](../artifacts/test-results/live-gke-matrix-summary-2026-10-27.json)
- [`artifacts/test-results/issue-fixes-verification-2026-10-27.json`](../artifacts/test-results/issue-fixes-verification-2026-10-27.json)

| ID | Scenario | Status | Evidence Artifact | Summary of Live GKE Result |
| :--- | :--- | :--- | :--- | :--- |
| **L01** | Basic live inference | **PASS** | [`L01-basic-inference.json`](../artifacts/test-results/L01-basic-inference.json) | Real prompt routed via Envoy/EPP to `vLLM` CPU (`Qwen/Qwen2.5-0.5B-Instruct`), HTTP `200`, `10`–`13` OTel spans (`observer.infer` + EPP child spans). |
| **L02** | Live streaming | **PASS** | [`L01-L04-live-results.json`](../artifacts/test-results/L01-L04-live-results.json) | SSE streaming (`req_44041d5a6f3f4f60`): True TTFT `32.72 ms`, Mean ITL `26.66 ms`, `36` token chunks, `prefill_duration_ms` = `unavailable`. |
| **L03** | Event & trace correlation | **PASS** | [`L01-L04-live-results.json`](../artifacts/test-results/L01-L04-live-results.json) | `100%` `request_id` and W3C `trace_id` correlation across Observer API events and Jaeger spans (`observer-api` + `llm-d-router/epp`). |
| **L04** | EPP routing & actual endpoint | **PASS** | [`issue-fixes-verification-2026-10-27.json`](../artifacts/test-results/issue-fixes-verification-2026-10-27.json) | Verified actual selected pod (`x-gateway-destination-endpoint: 10.20.1.14:8000` → `hlbrc`) recorded on `observer.infer` span and UI, distinct from candidate rankings. |
| **L05** | Long vs. short prompt | **PASS** | [`L05-prompt-length-comparison.json`](../artifacts/test-results/L05-prompt-length-comparison.json) | Short prompt TTFT `30.38 ms` vs. long prompt TTFT `38.45 ms`; `vllm:prompt_tokens_total` `1072 -> 1109 -> 1502`; `prefill_duration_ms` remains `unavailable`. |
| **L06** | Long generation (`96` tok) | **PASS** | [`L06-long-generation-streaming.json`](../artifacts/test-results/L06-long-generation-streaming.json) | 96-token stream (`req_d6ebde2328ca4e14`): True TTFT `30.89 ms`, Mean ITL `27.83 ms`, p95 ITL `53.13 ms`, Decode throughput `35.94 tok/s`. |
| **L07** | Concurrency & Flow Control | **PASS** | [`L07-flow-control-queueing.json`](../artifacts/test-results/L07-flow-control-queueing.json) | 12-request burst (`router_mode=flow-control`): `llm_d_epp_flow_control_queue_size` peaked at `8`, saturation at `2.0`, `vllm:num_requests_running` capped at `4.0`. |
| **L08** | Multiple model replicas | **PASS** | [`L08-multi-replica-distribution.json`](../artifacts/test-results/L08-multi-replica-distribution.json) | 8 concurrent requests split `4.0` to `hlbrc` (`10.20.1.14`) and `4.0` to `sfm46` (`10.20.1.15`). |
| **L09** | Backend failure & recovery | **PASS** | [`L09-backend-failure-recovery.json`](../artifacts/test-results/L09-backend-failure-recovery.json) | Single-replica failover (`ready_endpoints=1`, HTTP `200`), 0-endpoint failure (HTTP `503`, `status=failed`), and label restoration recovery (`ready_endpoints=2`, HTTP `200`). |
| **L10** | Client cancellation | **PASS** | [`L10-client-cancellation.json`](../artifacts/test-results/L10-client-cancellation.json) | Mid-stream disconnect after 3 chunks transitioned `req_9678ff3828294f25` to `status=cancelled` and incremented `observer_requests_total{status="cancelled"}`. |
| **L11** | Live aggregate metrics & KV hits | **PASS** | [`issue-fixes-verification-2026-10-27.json`](../artifacts/test-results/issue-fixes-verification-2026-10-27.json) | `epp_scrape_status=scraped` (`:9090` w/ RBAC bearer token), `vllm_scrape_status=scraped` (`:8000` headless DNS); `llm_d_epp_kv_cache_index_lookup_hits_total=2` (`128` cached tokens), `flow_control_queue_size=0` (`aggregate`). |
| **L12** | UI & local mode distinction | **PASS** | [`L12-live-ui-verification.json`](../artifacts/test-results/L12-live-ui-verification.json) | Playwright Chromium verification against `http://127.0.0.1:8088/` confirmed `0` mock banners, `0` simulated badges, and real token streaming. |
| **L13** | Performance benchmark | **PASS** | [`live-gke-benchmark-report.json`](../artifacts/benchmarks/live-gke-benchmark-report.json) | `8/8` measured streaming requests (`concurrency=2`): TTFB p50 `201.01 ms`, True TTFT p50 `273.88 ms`, E2E p50 `1376.34 ms`, `22.18 tok/s`. |
| **L14** | Resource health | **PASS** | [`L14-resource-health.json`](../artifacts/test-results/L14-resource-health.json) | All `8` Pods in `llm-d-observatory` `Running`/`Ready` with `0` restarts; all `3` Prometheus targets `up`. |

---

## 2. Running the Full Local Test Suite

Run all backend, frontend, E2E, manifest, Terraform, and benchmark checks from the repository root:

```bash
make verify-all
```

### 2.1 Go Backend Unit, Race & Integration Tests (`make test-go`)

```bash
cd backend/observer
test -z "$(gofmt -l .)"
go vet ./...
go test -v -race ./...
```

Covered test suites (`11` tests across `10` packages):
- [`internal/config/config_test.go`](../backend/observer/internal/config/config_test.go): `TestValidateUpstreamURLAllowlist`, `TestIsModelAllowed`.
- [`internal/redact/redact_test.go`](../backend/observer/internal/redact/redact_test.go): `TestScrubStringAndPromptRedaction` (verifies SHA-256 prompt redaction, secret scrubbing, and preservation of `prompt_tokens_source`, `completion_tokens_source`, and `epp_token_backend`).
- [`internal/events/hub_test.go`](../backend/observer/internal/events/hub_test.go): `TestHubOrderingCorrelationAndPrefillNeverInferredFromTTFT`.
- [`internal/telemetry/telemetry_test.go`](../backend/observer/internal/telemetry/telemetry_test.go): `TestW3CTraceContextPropagationAndJaegerFetch`, `TestMetricsClassificationAndPrometheusScraping`, `TestMissingMetricsRemainUnavailableWhenSubsystemsDisabled`.
- [`internal/server/server_test.go`](../backend/observer/internal/server/server_test.go): `TestRealUpstreamStreamForwardingAndTrueTTFT`, `TestSecurityBoundariesAndMockScenarios`, `TestNeverInferSelectedEndpointFromCandidateRankings`.
- [`internal/benchmark/runner_test.go`](../backend/observer/internal/benchmark/runner_test.go): `TestBenchmarkHarnessStreamingAndExport`.

### 2.2 Frontend Typecheck, Lint & Unit/Component Tests (`make test-frontend`)

```bash
cd frontend
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Covered component tests ([`frontend/src/test/observatory.test.tsx`](../frontend/src/test/observatory.test.tsx) — `6` tests):
1. `renders distinct badges for observed, measured, aggregate, derived, unavailable, and simulated`
2. `sorts out-of-order network events deterministically by sequence and preserves unavailable prefill duration`
3. `displays actual selected endpoint and explicit token provenance separately from candidate rankings`
4. `renders aggregate metrics with explicit scope notice`
5. `switches between all 13 architecture and telemetry modules`
6. `steps through the inference journey and switches between node and connection inspectors`

### 2.3 Playwright End-to-End Browser Tests (`make test-e2e`)

```bash
cd frontend
pnpm test:e2e
```

Covered E2E suites ([`frontend/e2e/observatory.spec.ts`](../frontend/e2e/observatory.spec.ts) — `4` comprehensive multi-step browser tests):
1. **`1-4 & 9-10`**: Verifies `LOCAL DEMO / MOCK MODE ACTIVE` banner, submits prompt in Playground, verifies live streaming output and `req_...` ID, verifies all lifecycle events in Timeline, steps through the **Interactive Topology** journey (`topology-step-submit` → `topology-step-next` → `topology-reset`), switches to Connection Inspector (`topology-edge-pill-e-gateway-epp`), and verifies aggregate metrics in Metrics.
2. **`5`**: Cancels an in-flight `cancel` stream mid-generation and verifies `cancelled` status and `timeline-event-request.cancelled`.
3. **`6`**: Runs the `saturated` scenario and verifies HTTP `429` error alert, `queue.observed`, and `request.failed`.
4. **`7 & 8`**: Runs `partial_trace` (verifying `trace-warning-banner` and `prefill-duration-value = Unavailable`) and `delayed_trace` (verifying asynchronous transition to `enriched` and `timeline-event-trace.enriched`).

### 2.4 Helm Rendering, Kubernetes Manifest Validation & Container Smoke Tests

```bash
make validate-manifests
make docker-build
make compose-smoke
```

- `make validate-manifests`: Renders all 3 Helm router profiles (`optimized-baseline`, `precise-prefix-cache`, `flow-control`) and validates `67` Kubernetes resource documents across `13` manifest files, verifying `--tracing=true` and `OBSERVER_MOCK_MODE="false"`.
- `make compose-smoke`: Builds and starts the multi-container Docker Compose stack (`observer-api` + `frontend`) and verifies `/healthz`, `/readyz`, `/version`, and `POST /api/infer`.

---

## 3. Performance Metrics & Benchmark Methodology

The Go benchmark CLI ([`backend/observer/cmd/benchmark/main.go`](../backend/observer/cmd/benchmark/main.go)) measures streaming inference across four distinct latency and throughput dimensions:

| Metric | Formula / Definition | Classification |
| :--- | :--- | :--- |
| **TTFB (`ttfb_ms`)** | $t_{\text{headers}} - t_{\text{send}}$ — HTTP response header arrival latency. | `measured` |
| **True TTFT (`ttft_ms`)** | $t_{\text{token\_1}} - t_{\text{send}}$ — Arrival of the first non-empty `choices[0].delta.content` token (ignoring initial `role:"assistant", content:""` chunks). | `measured` |
| **Inter-Token Latency (`itl_ms`)** | $\Delta t_i = t_{\text{token\_}i} - t_{\text{token\_}(i-1)}$ for $i \in [2..N]$, summarized via Mean and p95. | `measured` / `derived` |
| **Decode Speed (`tokens_per_sec`)** | $(N - 1) / (t_{\text{done}} - t_{\text{token\_1}})$ — Autoregressive generation speed excluding TTFT. | `derived` |
| **End-to-End Duration (`duration_ms`)** | $t_{\text{done}} - t_{\text{send}}$ — Complete wall-clock time until `data: [DONE]`. | `measured` |

### CPU Benchmark Limitations & Warmup Requirements
- **First-Inference JIT Compilation (`~85–95s`):** `vllm-openai-cpu:v0.31.0` compiles PyTorch/OneDNN AMX kernels on the first request after pod startup. Always pass `--warmup >= 1` so cold compilation is excluded from measured percentiles.
- **DDR5 Memory Bandwidth Ceiling:** On a single `c3-standard-22` (`22 vCPU`) running two `Qwen/Qwen2.5-0.5B-Instruct` replicas (`8 vCPU` each), single-stream decode speed is `~34–36 tok/s` (`~27–28 ms` Mean ITL). Under concurrent load (`concurrency >= 4`), memory bandwidth contention increases Mean ITL proportionally.

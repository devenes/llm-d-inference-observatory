# Testing & Validation Guide

## 1. Validation Honesty Statement

> [!IMPORTANT]
> **Local Validation Only (No Live GKE Cluster Created):**
> All tests and validations recorded in this repository were executed locally against the Go backend, React/TypeScript frontend, deterministic mock simulator (`OBSERVER_MOCK_MODE=true`), local `httptest` OpenAI-compatible SSE upstream servers, offline Helm template renders, Kubernetes manifest schema validators, and `terraform validate` / `terraform plan`.
> **No live GKE cluster was provisioned or mutated during this preparation phase.**

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

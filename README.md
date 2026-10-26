# llm-d Inference Observatory

An interactive learning and observability platform that visualizes the real-time LLM inference lifecycle across **Gateway/Envoy Proxy → Endpoint Picker (EPP) → InferencePool → vLLM CPU Model Server** on CPU-only Google Kubernetes Engine (GKE), alongside a deterministic, offline-capable local demo mode (`OBSERVER_MOCK_MODE=true`).

> **Phase Status:** Preparation and local validation complete. **Zero Google Cloud infrastructure resources were created, modified, or deleted during this phase.** All cloud deployment scripts and Terraform plans are prepared and guarded for a later, separately authorized deployment.

---

## 1. Core Capabilities

When a user submits a prompt in the browser, the **Go Observer API** (`backend/observer/`) forwards a real OpenAI-compatible chat completion request to the allowlisted `llm-d` router while streaming correlated lifecycle events (`schema_version: "1"`) over Server-Sent Events (SSE):

1. **Prompt Submission & Redaction** — Validates model/token limits and scrubs raw prompt text and secrets from logs and trace attributes by default (`OBSERVER_REDACT_PROMPTS=true`).
2. **Request Acceptance & W3C Trace Correlation (`request.accepted`)** — Assigns a unique `request_id` (`X-Request-Id`) and starts an OpenTelemetry span (`traceparent`).
3. **Gateway / Proxy Forwarding (`gateway.forwarded`)** — Dispatches the request to the `llm-d` Envoy sidecar (`:8081`), which strips client-spoofed `x-gateway-destination-endpoint` headers and invokes EPP via gRPC `ext_proc` (`:9002`).
4. **Queueing & Admission Control (`queue.observed`)** — Captures `llm-d` Flow Control priority-band admission (`premium-traffic`, `standard-traffic`, `best-effort-traffic`) and HTTP `429` saturation shedding (`x-llm-d-request-dropped-reason: rejected-saturated`).
5. **Endpoint Picker Filtering & Scoring (`routing.started`, `endpoint.selected`)** — Observes EPP scheduling decisions (`prefix-cache-affinity-filter` calibrated to `peakPrefillThroughput: 350` tok/s on CPU + `token-load-scorer`).
6. **Model Server Arrival (`model.request.started`)** — Measures HTTP response header arrival from the selected `vllm-openai-cpu:v0.31.0` pod (`Qwen/Qwen2.5-0.5B-Instruct`).
7. **Prompt Prefill vs. True TTFT (`model.first_token`)** — Distinguishes HTTP `200 OK` header arrival and initial empty `{"role":"assistant","content":""}` metadata chunks from the first non-empty generated text token (**True TTFT**). Never infers exact prefill duration from TTFT alone.
8. **Autoregressive Token Decode (`model.token`, `model.stream.completed`)** — Streams tokens live to the browser while measuring per-token Inter-Token Latency (ITL) and deriving Mean/p95 ITL and Decode `tok/s`.
9. **Terminal State (`request.completed`, `request.cancelled`, `request.failed`)** — Propagates browser `AbortController` cancellations upstream to abort in-flight token generation immediately.
10. **Asynchronous Trace Enrichment (`trace.enriched`)** — Queries Jaeger (`:16686`) out-of-band after streaming completes so trace collection never delays token delivery.

---

## 2. Architecture Overview

```mermaid
flowchart LR
    subgraph Client["Browser Client"]
        UI["React 19 Observatory UI<br/>(5 Interactive Screens)"]
    end

    subgraph Observatory["Observatory Backend"]
        OBS["Go Observer API (:8080)<br/>OpenAI Proxy + SSE Hub"]
    end

    subgraph DataPath["llm-d Inference Data Path (GKE Namespace: llm-d-observatory)"]
        ENVOY["Envoy Proxy Sidecar (:8081)<br/>ORIGINAL_DST Routing"]
        EPP["llm-d Endpoint Picker (:9002)<br/>ext_proc Filter & Scorer"]
        POOL["InferencePool<br/>(inference.networking.k8s.io/v1)"]
        VLLM0["vLLM CPU Pod 0 (:8000)<br/>Qwen2.5-0.5B-Instruct"]
        VLLM1["vLLM CPU Pod 1 (:8000)<br/>Qwen2.5-0.5B-Instruct"]
    end

    subgraph Telemetry["Parallel Observability Pipeline (Out-of-Band)"]
        OTEL["OTel Collector (:4317/:4318)<br/>Attribute Redaction"]
        JAEGER["Jaeger (:16686)<br/>Distributed Trace Store"]
        PROM["Prometheus / GMP<br/>Aggregate Metrics Scraper"]
    end

    subgraph ControlPlane["Kubernetes Control Plane (NOT in Inference Data Path)"]
        K8S["kube-apiserver<br/>CRD Watchers Only"]
    end

    UI -->|"1. POST /api/infer/stream"| OBS
    OBS -.->|"2. SSE /api/requests/{id}/events"| UI
    OBS -->|"3. POST /v1/chat/completions + traceparent"| ENVOY
    ENVOY <-->|"4. gRPC ext_proc"| EPP
    EPP -->|"5. x-gateway-destination-endpoint"| POOL
    ENVOY -->|"6a. Selected Pod"| VLLM0
    ENVOY -->|"6b. Selected Pod"| VLLM1

    OBS -.->|"OTLP Spans"| OTEL
    EPP -.->|"OTLP Spans"| OTEL
    VLLM0 -.->|"OTLP Spans"| OTEL
    OTEL -.-> JAEGER
    JAEGER -.->|"Async /api/traces/{id}"| OBS

    PROM -.->|"Scrape :9090 (RBAC)"| EPP
    PROM -.->|"Scrape :8000"| VLLM0
    PROM -.->|"Scrape :8000"| VLLM1
    K8S -.->|"Watches Pods/CRDs"| EPP
```

---

## 3. Repository Structure

| Path | Description |
| :--- | :--- |
| `backend/observer/` | Go Observer API (`cmd/observer`), reproducible benchmark CLI (`cmd/benchmark`), SSE event hub, W3C tracing, Prometheus scraper, redaction engine, and mock simulator. |
| `frontend/` | React 19 + TypeScript + Vite + Tailwind CSS + `@xyflow/react` + Recharts 5-screen application with Vitest and Playwright E2E tests. |
| `terraform/` | Pinned Terraform (`hashicorp/google ~> 7.25`) for VPC, GKE Standard (`us-west4-a`), CPU node pools (`1x e2-standard-4` + `1x c3-standard-22`), Artifact Registry, and IAM. |
| `deploy/` | Kubernetes manifests, vendored `llm-d-router-standalone:v1.0.0` chart, router mode overlays (`optimized-baseline`, `precise-prefix-cache`, `flow-control`), OTel Collector, Jaeger, Prometheus, and NetworkPolicies. |
| `scripts/` | Safe automation scripts for preflight checks, Terraform planning, Helm rendering, manifest validation, local image builds, and guarded future GKE deployment/teardown. |
| `docs/` | Comprehensive architecture, lifecycle, observability, local development, operations, deployment, testing, security, cost/quota, and teardown guides. |
| `artifacts/` | Timestamped preflight inspection report (`artifacts/preflight/`) and validation/benchmark evidence (`artifacts/test-results/`). |

---

## 4. Quick Start (Local Demo Mode — Zero Cloud Dependencies)

### Run the Interactive Observatory Locally

```bash
# Start Go Observer API (OBSERVER_MOCK_MODE=true on :8080) + React Vite UI (:5173)
make dev
```

Open `http://localhost:5173` in your browser to explore:
- **Screen A — Inference Playground:** Prompt editor, model & router profile selectors, mock scenario switcher (`success`, `delay`, `saturated`, `cancel`, `partial_trace`, `delayed_trace`, `missing_metrics`), and live streaming output.
- **Screen B — Live Lifecycle Timeline:** Sequence-ordered stage table with observation badges (`observed`, `measured`, `aggregate`, `derived`, `unavailable`, `simulated`) and correlated OpenTelemetry spans.
- **Screen C — Interactive Topology:** `@xyflow/react` graph highlighting observed vs. configured vs. skipped nodes with an interactive Component Inspector.
- **Screen D — Metrics:** Rolling TTFT/ITL charts and system-wide aggregate metrics (`llm_d_epp_*` and `vllm:*`) clearly separated from single-request measurements.
- **Screen E — Learning Lab:** 13 technical walkthrough modules grounded in the validated `llm-d` `v1.0.0` + `vllm-openai-cpu:v0.31.0` configuration.

### Run the Full Local Validation Suite

```bash
make verify-all
```

This executes:
- `make test-go` (`gofmt`, `go vet`, `go test -v -race ./...`)
- `make test-frontend` (`tsc --noEmit`, `eslint`, `vitest run`)
- `make test-e2e` (Playwright Chromium E2E suite across all 10 lifecycle scenarios)
- `make tf-fmt` & `make tf-validate`
- `make validate-manifests` (renders all 3 Helm router modes and validates 65 Kubernetes resource documents)
- `make benchmark-mock` (runs the streaming benchmark harness and exports JSON/CSV reports to `artifacts/test-results/`)

---

## 5. Documentation Index

- [ARCHITECTURE.md](file:///Users/enes/GitHub/llm-d-inference-observatory/ARCHITECTURE.md) — System design, data path vs. control plane vs. telemetry path.
- [docs/TECH_STACK.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/TECH_STACK.md) — Pinned versions, image tags, and reference provenance.
- [docs/INFERENCE_LIFECYCLE.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/INFERENCE_LIFECYCLE.md) — Stage-by-stage walkthrough, event envelope contract, and observation classifications.
- [docs/OBSERVABILITY.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/OBSERVABILITY.md) — OpenTelemetry collector pipeline, Jaeger trace enrichment, and Prometheus/GMP metrics.
- [docs/LOCAL_DEVELOPMENT.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/LOCAL_DEVELOPMENT.md) — Local mock mode, scenario fixtures, and developer workflow.
- [docs/OPERATIONS.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/OPERATIONS.md) — CPU cold-start Torch/OneDNN JIT warmup, rolling update safeguards, and troubleshooting.
- [docs/DEPLOYMENT.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/DEPLOYMENT.md) — Future authorized GKE deployment runbook and acceptance criteria.
- [docs/TESTING.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/TESTING.md) — Unit, race, component, E2E, manifest, Terraform, and benchmark test guide.
- [docs/SECURITY.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/SECURITY.md) — SSRF allowlisting, prompt redaction, non-root containers, RBAC, and NetworkPolicies.
- [docs/COST_AND_QUOTAS.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/COST_AND_QUOTAS.md) — Regional `us-west4` CPU quota math (`C3_CPUS=50`) and `~$1.36/hr` low-cost profile.
- [docs/TEARDOWN.md](file:///Users/enes/GitHub/llm-d-inference-observatory/docs/TEARDOWN.md) — Clean resource destruction and zero-spend verification checklist.

# Technology Stack & Version Provenance

All infrastructure, Kubernetes CRDs, container images, and application dependencies in `llm-d-inference-observatory` are pinned and cross-referenced against the validated `llm-d-gke-cpu-lab` reference architecture.

---

## 1. Inference & Routing Stack (GKE Data Path)

| Component | Pinned Version / Image Tag | Provenance & Compatibility Notes |
| :--- | :--- | :--- |
| **GKE Standard** | `REGULAR` channel (`1.36.4-gke.1495002` verified) | Zonal cluster in `us-west4-a`; Workload Identity + Managed Prometheus enabled. |
| **CPU Inference Node Pool** | `c3-standard-22` (4th Gen Intel Xeon Sapphire Rapids) | `22` vCPU, `88` GB DDR5 RAM, hardware AMX (`amx_bf16`, `amx_tile`, `amx_int8`). |
| **System / Router Node Pool** | `e2-standard-4` | `4` vCPU, `16` GB RAM hosting `llm-d-router-epp`, `observer-api`, `frontend`, and telemetry pods. |
| **Gateway API Inference Extension (GAIE)** | `v1.6.2` | Provides `InferencePool` (`inference.networking.k8s.io/v1`). |
| **llm-d Router Standalone Chart** | `oci://ghcr.io/llm-d/charts/llm-d-router-standalone:v1.0.0` | Vendored at `deploy/charts/llm-d-router-standalone-v1.0.0.tgz` for offline rendering. |
| **llm-d Endpoint Picker (EPP)** | `ghcr.io/llm-d/llm-d-router-endpoint-picker:v1.0.0` | Provides `EndpointPickerConfig` and `InferenceObjective` (`llm-d.ai/v1`). |
| **Envoy Proxy Sidecar** | `docker.io/envoyproxy/envoy:distroless-v1.33.2` | Bundled in `llm-d-router-epp` pod (`:8081` HTTP listener, `:19001` readiness/stats). |
| **vLLM CPU Model Server** | `docker.io/vllm/vllm-openai-cpu:v0.31.0` | Configured with `--enable-prefix-caching`, `--block-size=64`, `VLLM_CPU_KVCACHE_SPACE=4`. |
| **Default CPU Model** | `Qwen/Qwen2.5-0.5B-Instruct` | Ungated BF16 causal LM (`2` replicas); optional `meta-llama/Llama-3.2-3B-Instruct` supported. |

---

## 2. Observability & Telemetry Stack

| Component | Pinned Version / Image Tag | Role |
| :--- | :--- | :--- |
| **OpenTelemetry Collector** | `otel/opentelemetry-collector-contrib:0.114.0` | Receives OTLP gRPC (`:4317`) and HTTP (`:4318`), deletes sensitive prompt/secret attributes, exports to Jaeger. |
| **Jaeger All-in-One** | `jaegertracing/all-in-one:1.62.0` | In-memory trace store (`MEMORY_MAX_TRACES=2000`) queried by Observer API on `:16686`. |
| **Prometheus** | `prom/prometheus:v2.55.1` | Scrapes Observer API (`:8080/metrics`), EPP (`:9090/metrics` with RBAC Bearer token), and vLLM (`:8000/metrics`). |
| **OpenTelemetry Go SDK** | `go.opentelemetry.io/otel v1.34.0` | W3C `TraceContext` propagation and OTLP trace span generation in `backend/observer/`. |

---

## 3. Application & Infrastructure Stack

| Layer | Technology | Version |
| :--- | :--- | :--- |
| **Backend Language** | Go | `1.24+` (validated on `go1.27.2 darwin/arm64`) |
| **Frontend Framework** | React + TypeScript + Vite | React `19.3`, TypeScript `5.7`, Vite `6.4` |
| **Styling & Topology** | Tailwind CSS + `@xyflow/react` + Recharts | Tailwind `4.3`, `@xyflow/react` `12.12`, Recharts `2.15` |
| **Frontend Testing** | Vitest + React Testing Library + Playwright | Vitest `3.2`, Playwright `1.64` |
| **Infrastructure as Code** | Terraform + `hashicorp/google` | Terraform `>= 1.6.0`, provider `~> 7.25` (locked at `v7.46.2`) |

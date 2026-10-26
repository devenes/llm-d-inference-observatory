# GKE Deployment Guide (Verified on Live GKE Cluster `llm-d-observatory`)

> [!NOTE]
> **Live Deployment Verified (`2026-10-27`):**
> This runbook was executed against project `enes-turan-demo` (`us-west4-a`, GKE `v1.36.4-gke.2046003`, `24` Terraform resources). Published image digests:
> - `us-west4-docker.pkg.dev/enes-turan-demo/llm-d-observatory/observer-api:v0.1.0` (`sha256:d1f1e7d546451bfdaa63a331087227f8ba4e1e2c107975a8e28b93fc08887d30`)
> - `us-west4-docker.pkg.dev/enes-turan-demo/llm-d-observatory/observatory-frontend:v0.1.0` (`sha256:8534fd7eb5d20d24b2a66b1625035276dbf17e7470741e7091f7b1ad4705d5e1`)

---

## 1. Prerequisites

Ensure the following tools are installed locally:
- `gcloud` CLI authenticated against project `enes-turan-demo`
- `terraform` (`>= 1.6.0`, `< 2.0.0`)
- `kubectl` (`>= 1.31`)
- `helm` (`>= 3.14`)
- `docker` (with `linux/amd64` buildx support)

Verify project and region configuration:
```bash
export PROJECT_ID="enes-turan-demo"
export REGION="us-west4"
export ZONE="us-west4-a"
export CLUSTER_NAME="llm-d-observatory"

gcloud config set project "${PROJECT_ID}"
```

---

## 2. Step 1 — Validate Quotas & Terraform Plan

Before applying infrastructure, inspect regional quotas and the Terraform plan:
```bash
./scripts/preflight.sh
./scripts/tf-plan.sh
```

The default `experimental-small` profile provisions:
- **1x VPC Network & Subnet** (`10.42.0.0/20`, secondary pod/service ranges, Cloud Router + Cloud NAT)
- **1x Artifact Registry Repository** (`us-west4-docker.pkg.dev/enes-turan-demo/llm-d-observatory`)
- **1x GKE Standard Zonal Cluster** (`us-west4-a`, Workload Identity enabled, Gateway API `CHANNEL_STANDARD` enabled)
- **System Node Pool**: `1x e2-standard-4` (`4 vCPU`, `16 GB RAM`) — hosts Observer API, Frontend, OpenTelemetry Collector, Jaeger, Prometheus, and system controllers
- **Inference Node Pool**: `1x c3-standard-22` (`22 vCPU` Intel Sapphire Rapids AMX, `88 GB RAM`, label `llm-d.ai/inference-node=true`) — hosts `2x vLLM CPU` pods (`8 vCPU` each) + `llm-d Router` + `Endpoint Picker (EPP)`

---

## 3. Step 2 — Provision Infrastructure (When Authorized)

```bash
cd terraform
terraform apply
cd ..
```

Fetch GKE cluster credentials:
```bash
gcloud container clusters get-credentials "${CLUSTER_NAME}" \
  --zone "${ZONE}" \
  --project "${PROJECT_ID}"
```

---

## 4. Step 3 — Build & Publish Container Images

Build and push the Go Observer API and React Frontend images (`linux/amd64`) to Artifact Registry:
```bash
./scripts/build-images.sh
./scripts/publish-images.sh
```

---

## 5. Step 4 — Deploy the Stack to GKE

Run the automated deployment script, which:
1. Installs Gateway API Inference Extension CRDs (`InferencePool` `v1` and `InferenceObjective` `v1alpha2`).
2. Creates namespace `llm-d-observatory`.
3. Deploys OpenTelemetry Collector, Jaeger, and Prometheus in `llm-d-observatory`.
4. Installs the `llm-d-router-standalone:v1.0.0` Helm release (`router.tracing.enabled=true` and `OTEL_BSP_SCHEDULE_DELAY=200`) and `InferenceObjective` tiers (`premium-traffic`, `standard-traffic`, `best-effort-traffic`).
5. Deploys `experimental-small-vllm-decode` (`2` replicas of `Qwen/Qwen2.5-0.5B-Instruct` on `vllm-openai-cpu:v0.31.0`) in `llm-d-observatory`.
6. Deploys the Go Observer API (`observer-api`) and React Frontend (`observatory-frontend`), plus Kubernetes NetworkPolicies.

```bash
./scripts/deploy-gke.sh
```

To switch between scheduler profiles (`optimized-baseline`, `precise-prefix-cache`, `flow-control`):
```bash
ROUTER_MODE=flow-control ./scripts/deploy-gke.sh
```

---

## 6. Step 5 — Warmup & Live Smoke Verification

> [!WARNING]
> **First-Inference Torch/OneDNN Compilation Latency (`~85–95s`):**
> After `experimental-small-vllm-decode` pods pass their `/v1/models` readiness probe, the very first `/v1/chat/completions` request triggers PyTorch/OneDNN C++ kernel compilation on `c3-standard-22`, taking `~85–95s`. Subsequent requests complete in `~30–40ms` True TTFT (`~0.6–1.4s` total).

Run the automated smoke test:
```bash
./scripts/smoke-test.sh --url http://127.0.0.1:8080
```

To access the interactive Observatory UI in your browser:
```bash
kubectl -n llm-d-observatory port-forward svc/observatory-frontend 8088:8080 &
kubectl -n llm-d-observatory port-forward svc/observer-api 8080:8080 &
kubectl -n llm-d-observatory port-forward svc/jaeger-query 16686:16686 &
kubectl -n llm-d-observatory port-forward svc/prometheus 19090:9090 &
open http://127.0.0.1:8088
```

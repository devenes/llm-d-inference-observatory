# Operations & Troubleshooting Guide

This guide documents operational behaviors and known constraints discovered and audited on GKE Standard (`1.36.4-gke.1495002`) with `llm-d` `v1.0.0` and `vllm/vllm-openai-cpu:v0.31.0`.

---

## 1. Critical Operational Safeguards on CPU GKE

### 1.1 vLLM CPU First-Request Torch/OneDNN JIT Compilation Delay (`~85–95s`)
- **Symptom:** `kubectl get pods` shows `experimental-small-vllm-decode` as `1/1 Ready` (`GET /v1/models` returns `200 OK`), but the very first inference request takes `~85–95 seconds` before emitting its first token.
- **Root Cause:** `vllm-openai-cpu:v0.31.0` compiles Torch/OneDNN C++ AMX CPU kernels lazily on the first forward pass.
- **Mitigation:** Always warm up every ready vLLM pod with a 2-token request (`--warmup=1` in the benchmark CLI or a pre-benchmark curl) before recording latency measurements.

### 1.2 Calibrating `peakPrefillThroughput: 350` for CPU Prefix-Cache Affinity
- **Symptom:** Under concurrent bursts on CPU, all requests route to a single vLLM replica while the second replica sits idle.
- **Root Cause:** The upstream `prefix-cache-affinity-filter` default `peakPrefillThroughput` is `15928` tok/s (calibrated for `Qwen3-32B` on `2x H100` GPUs). On `c3-standard-22` CPUs, single-replica prefill throughput is `~250–500` tok/s, so the GPU threshold never detects CPU prefill saturation.
- **Mitigation:** [router-values.yaml](../deploy/llm-d/router-values.yaml) and [precise-prefix-cache-values.yaml](../deploy/llm-d/precise-prefix-cache-values.yaml) explicitly set `peakPrefillThroughput: 350`.

### 1.3 Single-Node Rolling Update Deadlock at `replicas >= 3`
- **Symptom:** Scaling `experimental-small-vllm-decode` to `3` replicas and triggering a rolling update leaves the new pod stuck in `Pending (0/2 nodes available: 1 Insufficient cpu, 1 node(s) didn't match Pod's nodeAffinity/selector)`.
- **Root Cause:** A single `c3-standard-22` node has `21,875m` allocatable CPU. With `requests.cpu: 6` (`6,000m`) per vLLM pod and `~740m` DaemonSet overhead, `2` replicas use `12,740m` (`9,135m` free, allowing `maxSurge: 1` during rollouts). At `3` replicas (`18,740m` used), a `maxSurge: 1` rollout requires `24,740m` (`2,865m` shortfall).
- **Mitigation:** Keep `replicas: 2` on a single `c3-standard-22` node, or scale `inference_node_count = 2` (`44 / 50` regional `C3_CPUS` quota).

### 1.4 `kubectl port-forward svc/...` Single-Pod Pinning
- **Symptom:** Port-forwarding to a Kubernetes `Service` (`kubectl port-forward svc/vllm-basic-service 8000:8000`) routes 100% of requests to a single pod IP (`10/0` split) because `port-forward` resolves one backing pod at tunnel creation time.
- **Mitigation:** Always send requests through `svc/llm-d-router-epp:80` (where Envoy balances across pod IPs directly in-cluster) or open per-pod port-forwards when benchmarking raw L4 round-robin.

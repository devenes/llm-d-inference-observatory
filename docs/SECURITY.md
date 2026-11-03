# Security Architecture & Hardening

The `llm-d-inference-observatory` platform enforces defense-in-depth across the Go Observer API, React Frontend, OpenTelemetry Collector, Kubernetes runtime, and network topology.

---

## 1. SSRF Prevention & Upstream Allowlisting

The Go Observer API never accepts arbitrary upstream URLs from client requests:
- Upstream inference requests are routed exclusively to the configured `OBSERVER_UPSTREAM_URL` (default `http://llm-d-router-epp.llm-d-observatory.svc.cluster.local:80`).
- Startup configuration validation ([`config.go`](../backend/observer/internal/config/config.go#L213-L232)) parses `OBSERVER_UPSTREAM_URL` and verifies its hostname against `OBSERVER_ALLOWED_UPSTREAM_HOSTS`. If the upstream host is not explicitly allowlisted, the server refuses to start.

---

## 2. Input Validation, Rate Limiting & Resource Protection

To protect CPU-only `vLLM` model servers from denial-of-service:
- **HTTP Body Limit**: Request bodies on `/api/infer` and `/api/infer/stream` are capped by `http.MaxBytesReader` at `OBSERVER_MAX_BODY_BYTES` (default `64 KiB` / `65536` bytes).
- **Max Generation Tokens**: Requested `max_tokens` exceeding `OBSERVER_MAX_OUTPUT_TOKENS` (default `1024`) are rejected with `400 Bad Request`.
- **Model Allowlist**: Only models listed in `OBSERVER_ALLOWED_MODELS` (default `Qwen/Qwen2.5-0.5B-Instruct`) are accepted; unknown models return `400 Bad Request`.
- **In-Flight Concurrency Semaphore**: Active inference requests are bounded by a non-blocking semaphore (`OBSERVER_MAX_CONCURRENT_REQUESTS`, default `16`). Excess concurrent requests fail fast with `429 Too Many Requests`.
- **Envoy Header Sanitization**: The `llm-d` Envoy proxy strips any client-supplied `x-gateway-destination-endpoint` header via `early_header_mutation_extensions` so external callers cannot spoof backend pod selection.

---

## 3. Prompt Privacy & Secret Redaction

Implemented in [`redact.go`](../backend/observer/internal/redact/redact.go):
- **Default Prompt Redaction (`OBSERVER_REDACT_PROMPTS=true`)**: Raw user prompts and generated completions are scrubbed from retained request records, trace span attributes, and structured logs by default. Only `prompt_chars`, `prompt_sha256` (first 16 hex chars of SHA-256), and numeric token/provenance attributes (`prompt_tokens`, `completion_tokens`, `prompt_tokens_source`, `completion_tokens_source`, `epp_token_count`, `epp_token_backend`) are preserved.
- **Secret Scrubbing**: Any attribute or string containing `Bearer <token>`, OpenAI keys (`sk-...`), HuggingFace tokens (`hf_...`), or sensitive keys (`authorization`, `api_key`, `secret`, `password`, `cookie`) is automatically scrubbed to `[REDACTED]`.
- **Collector-Level Redaction**: [`otel-collector.yaml`](../deploy/telemetry/otel-collector.yaml) runs an `attributes/redact` processor to delete `gen_ai.prompt`, `gen_ai.completion`, `llm.prompts`, `llm.completions`, `prompt`, and `authorization` before exporting spans to Jaeger.

---

## 4. Container & Pod Security Hardening

Both [`backend/observer/Dockerfile`](../backend/observer/Dockerfile) and [`frontend/Dockerfile`](../frontend/Dockerfile), as well as all Kubernetes manifests in `deploy/observatory/`, enforce:
- Non-root execution (`runAsNonRoot: true`, `runAsUser: 65532` / `101`).
- Read-only root filesystem (`readOnlyRootFilesystem: true`) on `observer-api`.
- Privilege escalation disabled (`allowPrivilegeEscalation: false`).
- All Linux capabilities dropped (`capabilities: { drop: ["ALL"] }`).
- Explicit CPU and memory `requests` and `limits` on every container.

---

## 5. Least-Privilege RBAC & NetworkPolicies

- **RBAC**:
  - `observer-api` and `prometheus` use a read-only `ClusterRole` (`llm-d-observatory-metrics-reader`) restricted to `/metrics` non-resource URLs (for EPP `:9090/metrics` controller-runtime authentication) and read-only `get/list/watch` on pods, services, and endpoints in `llm-d-observatory`.
- **NetworkPolicies ([`network-policies.yaml`](../deploy/network-policies/network-policies.yaml))**:
  - Restricts pod-to-pod traffic within `llm-d-observatory` to documented data-plane (`:8080`, `:8081`, `:9002`, `:8000`, `:5556`, `:5559`) and telemetry (`:4317`, `:4318`, `:9090`, `:16686`) ports.

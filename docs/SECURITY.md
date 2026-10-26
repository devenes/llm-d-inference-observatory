# Security Architecture & Hardening

The `llm-d-inference-observatory` platform enforces defense-in-depth across the Go Observer API, React Frontend, Kubernetes runtime, and network topology.

---

## 1. SSRF Prevention & Upstream Allowlisting

The Go Observer API never accepts arbitrary upstream URLs from client requests:
- Upstream inference requests are routed exclusively to the configured `OBSERVER_UPSTREAM_BASE_URL` (default `http://llm-d-inference-scheduling-router.llm-d.svc.cluster.local:8000`).
- Startup configuration validation (`backend/observer/internal/config/config.go`) parses `OBSERVER_UPSTREAM_BASE_URL` and verifies its hostname against `OBSERVER_ALLOWED_UPSTREAM_HOSTS`. If the upstream host is not explicitly allowlisted, the server refuses to start.

---

## 2. Input Validation, Rate Limiting & Resource Protection

To protect CPU-only `vLLM` model servers from denial-of-service:
- **HTTP Body Limit**: Request bodies on `/api/infer` and `/api/infer/stream` are capped by `http.MaxBytesReader` at `OBSERVER_MAX_BODY_BYTES` (default `32 KiB`).
- **Prompt Character Limit**: Prompts exceeding `OBSERVER_MAX_PROMPT_CHARS` (default `4,000` characters) are rejected with `400 Bad Request`.
- **Max Generation Tokens**: Requested `max_tokens` exceeding `OBSERVER_MAX_TOKENS_LIMIT` (default `512`) are rejected with `400 Bad Request`.
- **Model Allowlist**: Only models listed in `OBSERVER_ALLOWED_MODELS` (default `Qwen/Qwen2.5-0.5B-Instruct`) are accepted.
- **In-Flight Concurrency Semaphore**: Active inference requests are bounded by an atomic semaphore (`OBSERVER_MAX_CONCURRENT_REQUESTS`, default `8`). Excess concurrent requests fail fast with `429 Too Many Requests` (`concurrency_limit_exceeded`).

---

## 3. Prompt Privacy & Secret Redaction

Implemented in `backend/observer/internal/redact/redact.go`:
- **Default Prompt Redaction (`OBSERVER_STORE_RAW_PROMPTS=false`)**: Raw user prompts are never persisted in the in-memory request store, trace spans, or structured logs by default. Instead, only `prompt_chars`, `prompt_sha256` (first 16 hex chars of SHA-256), and an optional redacted preview are recorded.
- **Secret Scrubbing**: Any attribute or string containing `Bearer <token>`, OpenAI keys (`sk-...`), HuggingFace tokens (`hf_...`), or sensitive keys (`authorization`, `api_key`, `secret`, `password`, `cookie`) is automatically scrubbed to `[REDACTED]`.

---

## 4. Container & Pod Security Hardening

Both `backend/observer/Dockerfile` and `frontend/Dockerfile`, as well as all Kubernetes manifests in `deploy/observatory/`, enforce:
- Non-root execution (`runAsNonRoot: true`, `runAsUser: 65532`, `runAsGroup: 65532`).
- Read-only root filesystem (`readOnlyRootFilesystem: true`) where supported (`observer-api`, `otel-collector`).
- Privilege escalation disabled (`allowPrivilegeEscalation: false`).
- All Linux capabilities dropped (`capabilities: { drop: ["ALL"] }`).
- Explicit CPU and memory `requests` and `limits` on every container.

---

## 5. Least-Privilege RBAC & NetworkPolicies

- **RBAC**:
  - `observer-api` runs with a dedicated ServiceAccount (`observer-api` in `observatory`) with **zero Kubernetes API permissions** (`automountServiceAccountToken: false` compatible — it communicates only over HTTP with `llm-d`, Jaeger, and Prometheus).
  - `prometheus` uses a read-only ClusterRole (`deploy/telemetry/prometheus.yaml`) restricted to `get/list/watch` on pods, services, and endpoints.
- **NetworkPolicies (`deploy/network-policies/network-policies.yaml`)**:
  - `observer-api` is restricted to ingress from `observatory-frontend` and egress only to DNS (`53`), `llm-d` router (`8000`), `llm-d` EPP/vLLM metrics (`9090`, `8000`), and `telemetry` (`4318`, `16686`, `9090`).
  - `llm-d` pods only accept ingress on port `8000` from `observatory` and metrics scraping from `telemetry` and `observatory`.

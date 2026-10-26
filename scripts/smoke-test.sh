#!/usr/bin/env bash
# Runs smoke tests against either local Docker Compose (--local-compose) or an active endpoint.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODE="${1:---local-compose}"

if [ "${MODE}" = "--local-compose" ]; then
  echo "[smoke-test] Starting local Docker Compose stack..."
  cd "${REPO_ROOT}"
  docker compose up -d --build
  trap 'docker compose down -v' EXIT

  echo "[smoke-test] Waiting for Observer API (:8080/healthz) and Frontend (:8088/healthz)..."
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && curl -fsS http://127.0.0.1:8088/healthz >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  curl -fsS http://127.0.0.1:8080/healthz
  curl -fsS http://127.0.0.1:8080/readyz
  curl -fsS http://127.0.0.1:8080/version
  curl -fsS -X POST http://127.0.0.1:8088/api/infer \
    -H "Content-Type: application/json" \
    -d '{"model":"Qwen/Qwen2.5-0.5B-Instruct","prompt":"Smoke test","max_tokens":8,"stream":false}' | grep -q "chat.completion"
  echo "[smoke-test] PASS: Docker Compose stack verified."
else
  TARGET_URL="${TARGET_URL:-http://127.0.0.1:8080}"
  curl -fsS "${TARGET_URL}/healthz"
  curl -fsS "${TARGET_URL}/readyz"
  curl -fsS "${TARGET_URL}/version"
  echo "[smoke-test] PASS: Endpoint ${TARGET_URL} verified."
fi

#!/usr/bin/env bash
# Builds Observer API and Frontend container images locally without pushing to any registry.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "[build-images] Building local observer-api:local image..."
docker build -t llm-d-observatory/observer-api:local "${REPO_ROOT}/backend/observer"

echo "[build-images] Building local observatory-frontend:local image..."
docker build -t llm-d-observatory/observatory-frontend:local "${REPO_ROOT}/frontend"

echo "[build-images] PASS: Built local container images (no cloud push performed)."

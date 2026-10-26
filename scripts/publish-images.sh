#!/usr/bin/env bash
# Publishes Observer API and Frontend images to Google Artifact Registry.
# GUARDED: Will NOT execute unless ALLOW_CLOUD_MUTATION=true is explicitly set.
# WARNING: Running with ALLOW_CLOUD_MUTATION=true pushes artifacts to Google Cloud!
set -euo pipefail

if [ "${ALLOW_CLOUD_MUTATION:-false}" != "true" ]; then
  echo "[publish-images] BLOCKED BY SAFETY GUARD: Cloud mutation is prohibited in the preparation phase." >&2
  echo "[publish-images] To execute during a later authorized deployment, set ALLOW_CLOUD_MUTATION=true." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT_ID="${PROJECT_ID:-enes-turan-demo}"
REGION="${REGION:-us-west4}"
REPO_NAME="${REPO_NAME:-llm-d-observatory}"
TAG="${TAG:-v0.1.0}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}"

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

docker build -t "${REGISTRY}/observer-api:${TAG}" "${REPO_ROOT}/backend/observer"
docker push "${REGISTRY}/observer-api:${TAG}"

docker build -t "${REGISTRY}/observatory-frontend:${TAG}" "${REPO_ROOT}/frontend"
docker push "${REGISTRY}/observatory-frontend:${TAG}"

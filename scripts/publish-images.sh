#!/usr/bin/env bash
# Builds and publishes Observer API and Frontend linux/amd64 images to Google Artifact Registry.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT_ID="${PROJECT_ID:-enes-turan-demo}"
REGION="${REGION:-us-west4}"
REPO_NAME="${REPO_NAME:-llm-d-observatory}"
TAG="${TAG:-v0.1.0}"
PLATFORM="${PLATFORM:-linux/amd64}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}"

echo "[publish-images] Configuring Docker authentication for ${REGION}-docker.pkg.dev..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "[publish-images] Building and pushing ${REGISTRY}/observer-api:${TAG} (${PLATFORM})..."
docker build --platform "${PLATFORM}" -t "${REGISTRY}/observer-api:${TAG}" "${REPO_ROOT}/backend/observer"
docker push "${REGISTRY}/observer-api:${TAG}"

echo "[publish-images] Building and pushing ${REGISTRY}/observatory-frontend:${TAG} (${PLATFORM})..."
docker build --platform "${PLATFORM}" -t "${REGISTRY}/observatory-frontend:${TAG}" "${REPO_ROOT}/frontend"
docker push "${REGISTRY}/observatory-frontend:${TAG}"

echo "[publish-images] Verifying published images in Artifact Registry..."
gcloud artifacts docker images list "${REGISTRY}" --include-tags

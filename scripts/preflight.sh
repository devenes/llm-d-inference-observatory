#!/usr/bin/env bash
# Read-only preflight verification of local toolchains, CPU-only constraints, and GCP inventory.
# Does NOT create, modify, or delete any cloud resources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== [preflight] 1. Toolchain Verification ==="
for cmd in go node pnpm python3 terraform docker helm kubectl; do
  if command -v "${cmd}" >/dev/null 2>&1; then
    echo "  [OK] ${cmd}: $(command -v "${cmd}")"
  else
    echo "  [ERROR] Required CLI '${cmd}' not found in PATH" >&2
    exit 1
  fi
done

echo "=== [preflight] 2. Zero-GPU / Zero-TPU Guard ==="
if grep -R -E "nvidia\.com/gpu|cloud\.google\.com/gke-tpu|a2-|a3-|g2-" "${REPO_ROOT}/deploy" "${REPO_ROOT}/terraform/main.tf" >/dev/null 2>&1; then
  echo "  [ERROR] Found GPU/TPU accelerator references in deployment manifests or Terraform!" >&2
  exit 1
fi
echo "  [OK] CPU-only architecture confirmed across deploy/ and terraform/."

echo "=== [preflight] 3. Read-Only GCP Inventory (your-gcp-project-id) ==="
if command -v gcloud >/dev/null 2>&1; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  echo "  Active gcloud project: ${PROJECT:-unset}"
fi
echo "=== [preflight] PASS ==="

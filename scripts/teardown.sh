#!/usr/bin/env bash
# Teardown procedure for later authorized GKE deployments.
# Defaults to --dry-run and requires both --confirm and ALLOW_CLOUD_MUTATION=true to execute.
set -euo pipefail

MODE="${1:---dry-run}"

if [ "${MODE}" != "--confirm" ] || [ "${ALLOW_CLOUD_MUTATION:-false}" != "true" ]; then
  echo "[teardown] DRY-RUN MODE (no cloud resources modified)."
  echo "Planned teardown sequence for a future authorized deployment:"
  echo "  1. helm uninstall llm-d-router -n llm-d-observatory"
  echo "  2. kubectl delete namespace llm-d-observatory --wait=true"
  echo "  3. cd terraform && terraform destroy -auto-approve"
  echo "  4. Verify zero remaining GKE clusters, node pools, disks, and NAT routers."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

helm uninstall llm-d-router -n llm-d-observatory || true
kubectl delete namespace llm-d-observatory --ignore-not-found=true --wait=true
cd "${REPO_ROOT}/terraform"
terraform destroy -auto-approve

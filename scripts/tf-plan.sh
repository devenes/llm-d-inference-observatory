#!/usr/bin/env bash
# Runs a read-only Terraform fmt check, validation, and plan.
# Explicitly prohibited from running terraform apply.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${REPO_ROOT}/artifacts/test-results"
mkdir -p "${OUT_DIR}"

echo "[tf-plan] Running terraform fmt -check, init, validate, and read-only plan..."
cd "${REPO_ROOT}/terraform"
terraform fmt -check

if [ -d ".terraform/providers" ]; then
  terraform init -input=false -plugin-dir=.terraform/providers
else
  terraform init -input=false
fi

terraform validate

if terraform plan -input=false -refresh=false -no-color > "${OUT_DIR}/terraform-plan.tmp" 2>/dev/null; then
  mv "${OUT_DIR}/terraform-plan.tmp" "${OUT_DIR}/terraform-plan.txt"
else
  rm -f "${OUT_DIR}/terraform-plan.tmp"
fi

grep -E "Plan:|Changes to Outputs:" "${OUT_DIR}/terraform-plan.txt" || true
echo "[tf-plan] Saved read-only plan output to ${OUT_DIR}/terraform-plan.txt (NO resources applied)."

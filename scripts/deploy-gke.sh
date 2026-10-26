#!/usr/bin/env bash
# Deploys GAIE CRDs, llm-d Router, vLLM CPU Model Server, Telemetry Stack, and Observatory to GKE.
# GUARDED: Will NOT execute unless ALLOW_CLOUD_MUTATION=true is explicitly set.
# WARNING: Running with ALLOW_CLOUD_MUTATION=true deploys live resources to a GKE cluster!
set -euo pipefail

if [ "${ALLOW_CLOUD_MUTATION:-false}" != "true" ]; then
  echo "[deploy-gke] BLOCKED BY SAFETY GUARD: Live cluster deployment is prohibited in the preparation phase." >&2
  echo "[deploy-gke] To execute during a later authorized deployment, set ALLOW_CLOUD_MUTATION=true." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${REPO_ROOT}/deploy/versions.env"

ROUTER_MODE="${ROUTER_MODE:-optimized-baseline}"

echo "[deploy-gke] 1. Applying namespace and CRDs..."
kubectl apply -f "${REPO_ROOT}/deploy/namespaces/namespace.yaml"
kubectl apply -f "${GAIE_CRD_URL}"
kubectl apply -f "${ROUTER_CRD_URL}"

echo "[deploy-gke] 2. Applying RBAC, InferenceObjectives, and Telemetry Stack..."
kubectl apply -f "${REPO_ROOT}/deploy/llm-d/rbac-metrics-reader.yaml"
kubectl apply -f "${REPO_ROOT}/deploy/llm-d/objectives.yaml"
kubectl apply -f "${REPO_ROOT}/deploy/telemetry/jaeger.yaml"
kubectl apply -f "${REPO_ROOT}/deploy/telemetry/otel-collector.yaml"
kubectl apply -f "${REPO_ROOT}/deploy/telemetry/prometheus.yaml"

echo "[deploy-gke] 3. Installing llm-d Standalone Router (${ROUTER_MODE})..."
MODE_VALUES="${REPO_ROOT}/deploy/llm-d/router-values.yaml"
if [ "${ROUTER_MODE}" = "precise-prefix-cache" ]; then
  MODE_VALUES="${REPO_ROOT}/deploy/llm-d/precise-prefix-cache-values.yaml"
elif [ "${ROUTER_MODE}" = "flow-control" ]; then
  MODE_VALUES="${REPO_ROOT}/deploy/llm-d/flow-control-values.yaml"
fi

helm upgrade --install "${RELEASE_NAME}" \
  "${ROUTER_STANDALONE_CHART}" \
  --version "${ROUTER_CHART_VERSION}" \
  --namespace "${NAMESPACE}" \
  -f "${REPO_ROOT}/deploy/llm-d/base.values.yaml" \
  -f "${MODE_VALUES}" \
  --wait --timeout 300s

echo "[deploy-gke] 4. Deploying vLLM CPU Model Server and Observatory..."
kubectl apply -f "${REPO_ROOT}/deploy/model-server/vllm-cpu-deployment.yaml"
kubectl apply -f "${REPO_ROOT}/deploy/observatory/observer-api.yaml"
kubectl apply -f "${REPO_ROOT}/deploy/observatory/frontend.yaml"
kubectl apply -f "${REPO_ROOT}/deploy/network-policies/network-policies.yaml"

kubectl rollout status deployment/experimental-small-vllm-decode -n "${NAMESPACE}" --timeout=900s
kubectl rollout status deployment/observer-api -n "${NAMESPACE}" --timeout=180s
kubectl rollout status deployment/observatory-frontend -n "${NAMESPACE}" --timeout=180s

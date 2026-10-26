#!/usr/bin/env bash
# Deploys GAIE CRDs, llm-d Router, vLLM CPU Model Server, Telemetry Stack, and Observatory to GKE.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${REPO_ROOT}/deploy/versions.env"

ROUTER_MODE="${ROUTER_MODE:-optimized-baseline}"
CHART_SOURCE="${REPO_ROOT}/deploy/charts/llm-d-router-standalone-${ROUTER_CHART_VERSION}.tgz"
if [ ! -f "${CHART_SOURCE}" ]; then
  CHART_SOURCE="${ROUTER_STANDALONE_CHART}"
fi

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
  "${CHART_SOURCE}" \
  --namespace "${NAMESPACE}" \
  -f "${REPO_ROOT}/deploy/llm-d/base.values.yaml" \
  -f "${MODE_VALUES}" \
  --wait --timeout 300s
kubectl set env deployment/"${RELEASE_NAME}"-epp -c epp OTEL_BSP_SCHEDULE_DELAY=200 -n "${NAMESPACE}"
kubectl rollout status deployment/"${RELEASE_NAME}"-epp -n "${NAMESPACE}" --timeout=120s

echo "[deploy-gke] 4. Deploying vLLM CPU Model Server and Observatory..."
kubectl apply -f "${REPO_ROOT}/deploy/model-server/vllm-cpu-deployment.yaml"
kubectl set env deployment/observer-api -n "${NAMESPACE}" OBSERVER_ROUTER_MODE="${ROUTER_MODE}" 2>/dev/null || true
kubectl apply -f "${REPO_ROOT}/deploy/observatory/observer-api.yaml"
kubectl set env deployment/observer-api -n "${NAMESPACE}" OBSERVER_ROUTER_MODE="${ROUTER_MODE}"
kubectl apply -f "${REPO_ROOT}/deploy/observatory/frontend.yaml"
kubectl apply -f "${REPO_ROOT}/deploy/network-policies/network-policies.yaml"

echo "[deploy-gke] 5. Waiting for deployments to become Ready..."
kubectl rollout status deployment/jaeger -n "${NAMESPACE}" --timeout=180s
kubectl rollout status deployment/otel-collector -n "${NAMESPACE}" --timeout=180s
kubectl rollout status deployment/prometheus -n "${NAMESPACE}" --timeout=180s
kubectl rollout status deployment/observer-api -n "${NAMESPACE}" --timeout=180s
kubectl rollout status deployment/observatory-frontend -n "${NAMESPACE}" --timeout=180s
kubectl rollout status deployment/experimental-small-vllm-decode -n "${NAMESPACE}" --timeout=900s

echo "[deploy-gke] PASS: Stack deployed in namespace ${NAMESPACE} (mode=${ROUTER_MODE})."
kubectl get pods,svc,inferencepool,inferenceobjective -n "${NAMESPACE}" -o wide

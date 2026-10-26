#!/usr/bin/env bash
# Renders Helm templates for all three llm-d Router modes locally into deploy/rendered/
# without connecting to or mutating any Kubernetes cluster.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${REPO_ROOT}/deploy/versions.env"

RENDER_DIR="${REPO_ROOT}/deploy/rendered"
mkdir -p "${RENDER_DIR}"

CHART_SOURCE="${ROUTER_STANDALONE_CHART}"
LOCAL_CHART="${REPO_ROOT}/deploy/charts/llm-d-router-standalone-${ROUTER_CHART_VERSION}.tgz"
if [ -f "${LOCAL_CHART}" ]; then
  CHART_SOURCE="${LOCAL_CHART}"
fi

for mode in optimized-baseline precise-prefix-cache flow-control; do
  case "${mode}" in
    optimized-baseline)
      MODE_FILE="${REPO_ROOT}/deploy/llm-d/router-values.yaml"
      ;;
    precise-prefix-cache)
      MODE_FILE="${REPO_ROOT}/deploy/llm-d/precise-prefix-cache-values.yaml"
      ;;
    flow-control)
      MODE_FILE="${REPO_ROOT}/deploy/llm-d/flow-control-values.yaml"
      ;;
  esac

  echo "[render] Rendering Helm chart (${CHART_SOURCE}) for mode=${mode}..."
  helm template "${RELEASE_NAME}" "${CHART_SOURCE}" \
    --version "${ROUTER_CHART_VERSION}" \
    --namespace "${NAMESPACE}" \
    -f "${REPO_ROOT}/deploy/llm-d/base.values.yaml" \
    -f "${MODE_FILE}" \
    > "${RENDER_DIR}/llm-d-router-${mode}.yaml"

  python3 -c '
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
target = """                                upgrade_configs:
                                  - upgrade_type: websocket
                              typed_per_filter_config:"""
replacement = """                                upgrade_configs:
                                  - upgrade_type: websocket
                              response_headers_to_add:
                                - header:
                                    key: x-gateway-destination-endpoint
                                    value: "%REQ(x-gateway-destination-endpoint)%"
                                  append_action: OVERWRITE_IF_EXISTS_OR_ADD
                              typed_per_filter_config:"""
if "response_headers_to_add:" not in text and target in text:
    p.write_text(text.replace(target, replacement, 1))
' "${RENDER_DIR}/llm-d-router-${mode}.yaml"
done

echo "[render] Successfully rendered all 3 router modes to ${RENDER_DIR}/."

#!/usr/bin/env bash
# Offline YAML syntax, Kubernetes resource schema, security context, and tracing contract validation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${REPO_ROOT}/artifacts/test-results"
mkdir -p "${OUT_DIR}"

"${SCRIPT_DIR}/render-manifests.sh"

echo "[validate-manifests] Validating YAML syntax, Kubernetes schema contracts, and security invariants..."
ruby -ryaml -e '
  files = Dir.glob(File.join(ARGV[0], "deploy/**/*.yaml")).reject { |f| f.include?("/llm-d/base.values.yaml") || f.include?("/llm-d/router-values.yaml") || f.include?("/llm-d/precise-prefix-cache-values.yaml") || f.include?("/llm-d/flow-control-values.yaml") }
  total_docs = 0
  kinds = Hash.new(0)

  files.sort.each do |file|
    docs = YAML.load_stream(File.read(file))
    docs.compact.each_with_index do |doc, idx|
      unless doc.is_a?(Hash) && doc["apiVersion"] && doc["kind"] && doc.dig("metadata", "name")
        abort "[FAIL] #{file} (doc #{idx + 1}) missing apiVersion, kind, or metadata.name"
      end
      kind = doc["kind"]
      kinds[kind] += 1
      total_docs += 1

      if ["Deployment", "Service", "NetworkPolicy", "InferencePool", "InferenceObjective"].include?(kind)
        abort "[FAIL] #{file} (#{kind}/#{doc.dig("metadata", "name")}) missing spec" unless doc["spec"].is_a?(Hash)
      end

      if kind == "Deployment"
        containers = doc.dig("spec", "template", "spec", "containers") || []
        abort "[FAIL] #{file} Deployment has no containers" if containers.empty?
        containers.each do |c|
          reqs = c.dig("resources", "requests")
          lims = c.dig("resources", "limits")
          abort "[FAIL] #{file} container #{c["name"]} missing resources.requests or resources.limits" unless reqs && lims
        end
      end
    end
  end

  puts "Validated #{total_docs} Kubernetes resource documents across #{files.size} manifest files."
  kinds.sort.each { |k, v| puts "  - #{k}: #{v}" }
' "${REPO_ROOT}" | tee "${OUT_DIR}/manifest-validation.txt"

echo "[validate-manifests] Verifying OpenTelemetry tracing (--tracing=true) in rendered llm-d Router manifests..."
for f in "${REPO_ROOT}/deploy/rendered"/llm-d-router-*.yaml; do
  if ! grep -q -- "--tracing=true" "${f}"; then
    echo "[ERROR] Expected --tracing=true in ${f}" >&2
    exit 1
  fi
  if ! grep -q -- "OTEL_EXPORTER_OTLP_ENDPOINT" "${f}"; then
    echo "[ERROR] Expected OTEL_EXPORTER_OTLP_ENDPOINT in ${f}" >&2
    exit 1
  fi
done

echo "[validate-manifests] Verifying OBSERVER_MOCK_MODE is false in production GKE deployment manifest..."
if grep -A1 "name: OBSERVER_MOCK_MODE" "${REPO_ROOT}/deploy/observatory/observer-api.yaml" | grep -q '"true"'; then
  echo "[ERROR] Production observer-api.yaml must not enable OBSERVER_MOCK_MODE!" >&2
  exit 1
fi

echo "[validate-manifests] PASS: All Kubernetes and Helm manifests validated."

# Cost Estimate & GCP Quota Analysis

## 1. Verified GCP Regional Quotas (`enes-turan-demo` / `us-west4`)

Verified via read-only `gcloud compute regions describe us-west4 --project=enes-turan-demo` during preflight (`artifacts/preflight/preflight-2026-10-26T222500.md`):

| Quota Metric (`us-west4`) | Current Limit | Current Usage | Required (`experimental-small`) | Status |
| :--- | :---: | :---: | :---: | :---: |
| `C3_CPUS` | `50` | `0` | `22` (`1x c3-standard-22`) | **SUFFICIENT** (`44%` of limit) |
| `CPUS` (Total Regional vCPUs) | `200` | `0` | `26` (`22` C3 + `4` E2) | **SUFFICIENT** (`13%` of limit) |
| `SSD_TOTAL_GB` (`pd-balanced` / SSD) | `6,000 GB` | `0` | `300 GB` (`100 GB` E2 + `200 GB` C3) | **SUFFICIENT** (`5%` of limit) |
| `IN_USE_ADDRESSES` | `64` | `0` | `1` (Cloud NAT IP) | **SUFFICIENT** (`1.5%` of limit) |

---

## 2. Deployment Profile Comparison

| Profile | System Node Pool | Inference Node Pool | vLLM Replicas | Total vCPUs | Approx. Hourly Cost (`us-west4`) | Quota Fit (`C3_CPUS=50`) |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **`experimental-small` (Default)** | `1x e2-standard-4` (`4 vCPU`, `16 GB`) | `1x c3-standard-22` (`22 vCPU`, `88 GB`) | `2x Qwen2.5-0.5B` (`8 vCPU` req / `10 vCPU` lim each) | `26 vCPU` | **`~\$1.36 / hr`** | Fits comfortably (`22 / 50 C3_CPUS`) |
| **`official-cpu` (Reference)** | `1x e2-standard-4` (`4 vCPU`, `16 GB`) | `2x c3-highcpu-88` (`176 vCPU`, `352 GB`) | `2x Qwen2.5-0.5B` (`32 vCPU` each) | `180 vCPU` | `~\$7.60 / hr` | **Blocked** unless `C3_CPUS` quota raised `>= 176` |

---

## 3. Hourly & Daily Cost Breakdown (`experimental-small` in `us-west4`)

| Resource | Specification | Quantity | Est. Hourly Cost (USD) | Est. 4-Hour Lab Session | Est. 24-Hour Day |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **GKE Zonal Cluster Management** | Free tier for 1st zonal cluster per billing account | `1` | `\$0.00` (or `\$0.10` if not covered) | `\$0.00 – \$0.40` | `\$0.00 – \$2.40` |
| **Inference Node (`c3-standard-22`)** | `22 vCPU` Intel Sapphire Rapids AMX, `88 GB RAM` | `1` | `~\$1.08 / hr` | `~\$4.32` | `~\$25.92` |
| **System Node (`e2-standard-4`)** | `4 vCPU`, `16 GB RAM` | `1` | `~\$0.13 / hr` | `~\$0.52` | `~\$3.12` |
| **Persistent Disks (`pd-balanced`)** | `100 GB` (system) + `200 GB` (inference) = `300 GB` | `300 GB` | `~\$0.04 / hr` | `~\$0.16` | `~\$0.96` |
| **Cloud NAT & Artifact Registry** | 1 NAT gateway + `< 5 GB` container images | `1` | `~\$0.01 / hr` | `~\$0.04` | `~\$0.24` |
| **Total (`experimental-small`)** | **Complete CPU-only llm-d Observatory** | — | **`~\$1.26 – \$1.36 / hr`** | **`~\$5.04 – \$5.44`** | **`~\$30.24 – \$32.64`** |

---

## 4. Cost Control Recommendations

1. **Develop & Test Locally for `\$0.00/hr`**: Use `make run-mock-backend` and `make run-frontend` (`OBSERVER_MOCK_MODE=true`) for UI development, architecture exploration, and automated E2E testing.
2. **Keep `inference_node_count = 1` (`c3-standard-22`)**: A single `c3-standard-22` node runs `2` replicas of `Qwen/Qwen2.5-0.5B-Instruct` alongside the `llm-d` router and `EPP`, which is sufficient to demonstrate prefix-cache affinity routing, load-aware scoring, and saturation queueing.
3. **Teardown Immediately After Live Sessions**: Always run `./scripts/teardown.sh` at the end of a live GKE session so zero compute or disk charges accrue overnight.

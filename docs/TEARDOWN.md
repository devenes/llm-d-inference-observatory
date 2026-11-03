# Infrastructure Teardown Runbook

Use this runbook to cleanly destroy all Kubernetes workloads and Terraform-managed Google Cloud resources created by `llm-d-inference-observatory` in project `your-gcp-project-id`.

---

## 1. Automated Teardown Script

The repository includes [`scripts/teardown.sh`](../scripts/teardown.sh), which defaults to `--dry-run` unless both `--confirm` and `ALLOW_CLOUD_MUTATION=true` are passed:

```bash
# 1. Inspect planned teardown steps (safe dry-run)
./scripts/teardown.sh --dry-run

# 2. Execute full Kubernetes + Terraform teardown
ALLOW_CLOUD_MUTATION=true ./scripts/teardown.sh --confirm
```

What `./scripts/teardown.sh --confirm` executes:
1. Uninstalls the `llm-d-router` Helm release in namespace `llm-d-observatory`.
2. Deletes namespace `llm-d-observatory` so all Kubernetes Pods, Services, and ConfigMaps terminate cleanly.
3. Runs `terraform destroy -auto-approve` inside `terraform/` to destroy all 24 Terraform-managed resources:
   - `google_container_node_pool.cpu_inference_pool` (`1x c3-standard-22`)
   - `google_container_node_pool.system_pool` (`1x e2-standard-4`)
   - `google_container_cluster.primary` (`llm-d-observatory` in `us-west4-a`)
   - `google_artifact_registry_repository.observatory` (`llm-d-observatory` in `us-west4`)
   - `google_compute_router_nat.nat`, `google_compute_router.router`, `google_compute_firewall.allow_internal`, `google_compute_subnetwork.nodes`, and `google_compute_network.vpc`
   - `google_service_account.node_sa` and its `7` `google_project_iam_member.node_sa_roles` bindings
   - `google_project_service.required` state entries (with `disable_on_destroy = false` so project-wide Google Cloud APIs are never disabled).

---

## 2. Direct Terraform Destroy (Step-by-Step)

To inspect the destroy plan before executing:

```bash
cd terraform

# 1. Generate and inspect the destroy plan
terraform plan -destroy

# 2. Execute the destroy operation
terraform destroy -auto-approve
```

---

## 3. Post-Teardown Zero-Resource Verification

After `terraform destroy` completes, verify that zero project resources remain in `your-gcp-project-id`:

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-west4"

# 1. Verify Terraform state is empty
cd terraform && terraform state list && cd ..

# 2. Verify no GKE clusters remain
gcloud container clusters list --project="${PROJECT_ID}"

# 3. Verify no Compute Engine VM instances remain
gcloud compute instances list --project="${PROJECT_ID}"

# 4. Verify no orphaned Persistent Disks remain
gcloud compute disks list --project="${PROJECT_ID}"

# 5. Verify no Cloud NAT routers or VPC networks for llm-d-observatory remain
gcloud compute routers list --project="${PROJECT_ID}" --regions="${REGION}"
gcloud compute networks list --project="${PROJECT_ID}" --filter="name~llm-d-observatory"

# 6. Verify Artifact Registry repository is removed
gcloud artifacts repositories list --project="${PROJECT_ID}" --location="${REGION}"
```

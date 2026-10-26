# Infrastructure Teardown Runbook

> [!NOTE]
> During the current repository preparation phase, **no Google Cloud resources were created**, so no cloud teardown is currently needed. Use this runbook after any future authorized GKE deployment session.

---

## 1. Automated Teardown Script

The repository includes `./scripts/teardown.sh`, which safely deletes Kubernetes releases/namespaces and destroys all Terraform-managed infrastructure.

To run a full teardown after an authorized GKE deployment:
```bash
CONFIRM_DESTROY=true ./scripts/teardown.sh
```

What `./scripts/teardown.sh` does:
1. Checks safety guard `CONFIRM_DESTROY=true` (refuses to run without explicit confirmation).
2. Uninstalls the `llm-d-inference-scheduling` Helm release in namespace `llm-d`.
3. Deletes namespaces `observatory`, `llm-d`, and `telemetry` so any Kubernetes-managed resources release cleanly.
4. Runs `terraform destroy -auto-approve` inside `terraform/` to remove the GKE cluster, node pools, Cloud NAT, Cloud Router, VPC network, service accounts, and Artifact Registry repository.

---

## 2. Post-Teardown Zero-Resource Verification

After `teardown.sh` completes, verify that zero billable resources remain in `enes-turan-demo`:

```bash
export PROJECT_ID="enes-turan-demo"
export REGION="us-west4"

# 1. Verify no GKE clusters remain
gcloud container clusters list --project="${PROJECT_ID}"

# 2. Verify no Compute Engine VM instances remain
gcloud compute instances list --project="${PROJECT_ID}"

# 3. Verify no orphaned Persistent Disks remain
gcloud compute disks list --project="${PROJECT_ID}"

# 4. Verify no forwarding rules / load balancers remain
gcloud compute forwarding-rules list --project="${PROJECT_ID}"

# 5. Verify no Cloud NAT routers remain
gcloud compute routers list --project="${PROJECT_ID}" --regions="${REGION}"
```

All five commands should return `Listed 0 items.`

output "project_id" {
  description = "Google Cloud project ID."
  value       = var.project_id
}

output "region" {
  description = "Google Cloud region."
  value       = var.region
}

output "zone" {
  description = "Google Cloud zone."
  value       = var.zone
}

output "cluster_name" {
  description = "GKE Standard cluster name."
  value       = google_container_cluster.primary.name
}

output "cluster_endpoint" {
  description = "GKE cluster control-plane endpoint."
  value       = google_container_cluster.primary.endpoint
  sensitive   = true
}

output "vpc_network_name" {
  description = "Dedicated VPC network name."
  value       = google_compute_network.vpc.name
}

output "subnet_name" {
  description = "GKE nodes subnet name."
  value       = google_compute_subnetwork.nodes.name
}

output "node_service_account_email" {
  description = "Least-privilege GKE node service account email."
  value       = google_service_account.node_sa.email
}

output "artifact_registry_repository_url" {
  description = "Base Artifact Registry URL for pushing Observer API and Frontend images."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.observatory.repository_id}"
}

output "observer_image_uri" {
  description = "Full Artifact Registry image URI for the Go Observer API."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.observatory.repository_id}/${var.observer_image_name}:v0.1.0"
}

output "frontend_image_uri" {
  description = "Full Artifact Registry image URI for the React Observatory UI."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.observatory.repository_id}/${var.frontend_image_name}:v0.1.0"
}

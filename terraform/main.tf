locals {
  required_apis = toset([
    "compute.googleapis.com",
    "container.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "cloudtrace.googleapis.com",
  ])

  node_sa_roles = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
    "roles/artifactregistry.reader",
    "roles/container.defaultNodeServiceAccount",
    "roles/cloudtrace.agent",
  ])

  common_labels = {
    project          = "llm-d-inference-observatory"
    managed-by       = "terraform"
    deployment-tier  = var.deployment_profile
    accelerator-type = "cpu-only"
  }
}

# 1. Required Google Cloud APIs
resource "google_project_service" "required" {
  for_each           = local.required_apis
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# 2. Dedicated VPC & Subnet
resource "google_compute_network" "vpc" {
  name                    = "${var.cluster_name}-vpc"
  project                 = var.project_id
  auto_create_subnetworks = false
  depends_on              = [google_project_service.required]
}

resource "google_compute_subnetwork" "nodes" {
  name                     = "${var.cluster_name}-nodes"
  project                  = var.project_id
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.nodes_cidr
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }
}

resource "google_compute_router" "router" {
  name    = "${var.cluster_name}-router"
  project = var.project_id
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "${var.cluster_name}-nat"
  project                            = var.project_id
  region                             = var.region
  router                             = google_compute_router.router.name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

resource "google_compute_firewall" "allow_internal" {
  name    = "${var.cluster_name}-allow-internal"
  project = var.project_id
  network = google_compute_network.vpc.name

  allow {
    protocol = "icmp"
  }

  allow {
    protocol = "tcp"
    ports = [
      "80",
      "4317",
      "4318",
      "5556",
      "5559",
      "8000",
      "8080",
      "8081",
      "9002",
      "9003",
      "9090",
      "16686",
    ]
  }

  source_ranges = [
    var.nodes_cidr,
    var.pods_cidr,
    var.services_cidr,
  ]
}

# 3. Artifact Registry for Observer API and Frontend Images
resource "google_artifact_registry_repository" "observatory" {
  location      = var.region
  project       = var.project_id
  repository_id = var.artifact_registry_id
  description   = "Container images for llm-d Inference Observatory (Observer API and React UI)"
  format        = "DOCKER"
  labels        = local.common_labels
  depends_on    = [google_project_service.required]
}

# 4. Least-Privilege Node Service Account & IAM
resource "google_service_account" "node_sa" {
  account_id   = "${var.cluster_name}-node-sa"
  display_name = "GKE CPU Node Service Account for ${var.cluster_name}"
  project      = var.project_id
  depends_on   = [google_project_service.required]
}

resource "google_project_iam_member" "node_sa_roles" {
  for_each = local.node_sa_roles
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.node_sa.email}"
}

# 5. GKE Standard Cluster (Zonal CPU-Only)
resource "google_container_cluster" "primary" {
  provider = google-beta
  name     = var.cluster_name
  project  = var.project_id
  location = var.zone

  network    = google_compute_network.vpc.id
  subnetwork = google_compute_subnetwork.nodes.id

  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false
  networking_mode          = "VPC_NATIVE"

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
    managed_prometheus {
      enabled = true
      auto_monitoring_config {
        scope = "ALL"
      }
    }
  }

  resource_labels = local.common_labels

  depends_on = [
    google_project_service.required,
    google_project_iam_member.node_sa_roles,
  ]
}

# 6. System, Router & Observability Node Pool (e2-standard-4)
resource "google_container_node_pool" "system_pool" {
  name       = "system-pool"
  project    = var.project_id
  location   = var.zone
  cluster    = google_container_cluster.primary.name
  node_count = var.system_node_count

  node_config {
    machine_type    = var.system_machine_type
    disk_size_gb    = 50
    disk_type       = "pd-balanced"
    image_type      = "COS_CONTAINERD"
    service_account = google_service_account.node_sa.email

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    labels = merge(local.common_labels, {
      "role"               = "system"
      "llm-d.ai/node-role" = "system"
    })
  }
}

# 7. CPU Inference Node Pool (c3-standard-22 Intel Sapphire Rapids with AMX)
resource "google_container_node_pool" "cpu_inference_pool" {
  name       = "cpu-inference-pool"
  project    = var.project_id
  location   = var.zone
  cluster    = google_container_cluster.primary.name
  node_count = var.inference_node_count

  node_config {
    machine_type    = var.inference_machine_type
    disk_size_gb    = 100
    disk_type       = "pd-balanced"
    image_type      = "COS_CONTAINERD"
    service_account = google_service_account.node_sa.email

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    labels = merge(local.common_labels, {
      "role"                = "cpu-inference"
      "llm-d.ai/node-role"  = "inference"
      "llm-d.ai/cpu-family" = "intel-sapphire-rapids"
    })
  }
}

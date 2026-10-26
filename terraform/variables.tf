variable "project_id" {
  description = "Google Cloud project ID hosting the llm-d Inference Observatory."
  type        = string
  default     = "enes-turan-demo"
}

variable "region" {
  description = "Preferred Google Cloud region (must have Intel Sapphire Rapids C3 CPU quota)."
  type        = string
  default     = "us-west4"
}

variable "zone" {
  description = "Primary Google Cloud zone for the zonal GKE Standard cluster."
  type        = string
  default     = "us-west4-a"
}

variable "cluster_name" {
  description = "Project-specific resource prefix and GKE Standard cluster name."
  type        = string
  default     = "llm-d-observatory"
}

variable "deployment_profile" {
  description = "Sizing profile: experimental-small (1x e2-standard-4 + 1x c3-standard-22, ~$1.36/hr) or official-cpu."
  type        = string
  default     = "experimental-small"

  validation {
    condition     = contains(["experimental-small", "official-cpu"], var.deployment_profile)
    error_message = "deployment_profile must be either experimental-small or official-cpu."
  }
}

variable "system_machine_type" {
  description = "CPU machine type for the GKE system, router, and observability node pool."
  type        = string
  default     = "e2-standard-4"

  validation {
    condition     = !can(regex("^(a2|a3|a4|g2|ct|tpu)", var.system_machine_type))
    error_message = "GPU and TPU machine types are prohibited in this CPU-only architecture."
  }
}

variable "system_node_count" {
  description = "Number of nodes in the system node pool."
  type        = number
  default     = 1
}

variable "inference_machine_type" {
  description = "4th Gen Intel Xeon Sapphire Rapids (C3) CPU machine type with AMX BF16 support for vLLM CPU."
  type        = string
  default     = "c3-standard-22"

  validation {
    condition     = !can(regex("^(a2|a3|a4|g2|ct|tpu)", var.inference_machine_type))
    error_message = "GPU and TPU machine types are prohibited in this CPU-only architecture."
  }
}

variable "inference_node_count" {
  description = "Number of nodes in the CPU inference node pool (1x c3-standard-22 = 22 vCPUs, well within us-west4 C3_CPUS=50 quota)."
  type        = number
  default     = 1
}

variable "nodes_cidr" {
  description = "Primary CIDR range for GKE worker nodes."
  type        = string
  default     = "10.10.0.0/24"
}

variable "pods_cidr" {
  description = "Secondary CIDR range for GKE pods."
  type        = string
  default     = "10.20.0.0/16"
}

variable "services_cidr" {
  description = "Secondary CIDR range for GKE services."
  type        = string
  default     = "10.30.0.0/20"
}

variable "artifact_registry_id" {
  description = "Artifact Registry Docker repository ID for Observer API and Frontend container images."
  type        = string
  default     = "llm-d-observatory"
}

variable "observer_image_name" {
  description = "Container image name for the Go Observer API."
  type        = string
  default     = "observer-api"
}

variable "frontend_image_name" {
  description = "Container image name for the React Observatory UI."
  type        = string
  default     = "observatory-frontend"
}

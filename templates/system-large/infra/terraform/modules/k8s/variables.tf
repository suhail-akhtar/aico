variable "name" {
  description = "EKS cluster name (for example system-dev)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name must be 3-32 characters of lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "kubernetes_version" {
  description = "EKS Kubernetes minor version. Upgrade one minor at a time."
  type        = string
  default     = "1.36"

  validation {
    condition     = can(regex("^1\\.(3[0-9])$", var.kubernetes_version))
    error_message = "kubernetes_version must look like 1.36."
  }
}

variable "subnet_ids" {
  description = "Private subnets for the control plane network interfaces and the nodes."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "EKS needs subnets in at least two availability zones."
  }
}

variable "endpoint_public_access" {
  description = "Expose the Kubernetes API publicly (restricted to public_access_cidrs). Production keeps this false and reaches the API through a VPN or bastion."
  type        = bool
  default     = false
}

variable "public_access_cidrs" {
  description = "CIDRs allowed to reach the public API endpoint. Never 0.0.0.0/0."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.public_access_cidrs : can(cidrhost(c, 0)) && c != "0.0.0.0/0"])
    error_message = "public_access_cidrs must be valid IPv4 CIDRs and must not be 0.0.0.0/0."
  }
}

variable "node_instance_types" {
  description = "Instance types of the managed node group."
  type        = list(string)
  default     = ["m7i.large"]

  validation {
    condition     = length(var.node_instance_types) > 0
    error_message = "Provide at least one instance type."
  }
}

variable "node_capacity_type" {
  description = "ON_DEMAND or SPOT. Production runs ON_DEMAND."
  type        = string
  default     = "ON_DEMAND"

  validation {
    condition     = contains(["ON_DEMAND", "SPOT"], var.node_capacity_type)
    error_message = "node_capacity_type must be ON_DEMAND or SPOT."
  }
}

variable "node_min_size" {
  description = "Minimum number of nodes."
  type        = number
  default     = 2

  validation {
    condition     = var.node_min_size >= 1
    error_message = "node_min_size must be at least 1."
  }
}

variable "node_max_size" {
  description = "Maximum number of nodes (the cluster autoscaler or Karpenter works inside this range)."
  type        = number
  default     = 6

  validation {
    condition     = var.node_max_size >= 1
    error_message = "node_max_size must be at least 1."
  }
}

variable "node_desired_size" {
  description = "Initial number of nodes; Terraform ignores later changes so an autoscaler can own the value."
  type        = number
  default     = 3
}

variable "node_disk_size_gb" {
  description = "Root volume size of each node (gp3, encrypted)."
  type        = number
  default     = 50

  validation {
    condition     = var.node_disk_size_gb >= 20 && var.node_disk_size_gb <= 500
    error_message = "node_disk_size_gb must be between 20 and 500."
  }
}

variable "admin_principal_arns" {
  description = "IAM role or user ARNs granted cluster-admin through EKS access entries."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Retention of the control-plane log group."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a retention value CloudWatch Logs accepts."
  }
}

variable "tags" {
  description = "Tags merged onto every resource."
  type        = map(string)
  default     = {}
}

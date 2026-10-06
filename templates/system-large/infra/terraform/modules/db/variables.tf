variable "name" {
  description = "Name prefix (for example system-prod)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name must be 3-32 characters of lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "dev, staging or prod. Production turns the safety rails (deletion protection, Multi-AZ, long backups) into requirements."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "create_instance" {
  description = "Create the RDS instance. Set false when the primary database is CloudNativePG in the cluster: the backup bucket and role are still created."
  type        = bool
  default     = true
}

variable "vpc_id" {
  description = "VPC of the database."
  type        = string
}

variable "subnet_ids" {
  description = "Database subnets (at least two availability zones)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "A DB subnet group needs subnets in at least two availability zones."
  }
}

variable "client_security_group_ids" {
  description = "Security groups allowed to connect on 5432 (the EKS node security group)."
  type        = list(string)

  validation {
    condition     = length(var.client_security_group_ids) > 0
    error_message = "Name at least one client security group; the database accepts nothing else."
  }
}

variable "engine_version" {
  description = "PostgreSQL major or major.minor version. A major-only value lets RDS pick the current minor."
  type        = string
  default     = "18"

  validation {
    condition     = can(regex("^18(\\.[0-9]+)?$", var.engine_version))
    error_message = "engine_version must be PostgreSQL 18 (for example 18 or 18.4)."
  }
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.m7g.large"
}

variable "allocated_storage_gb" {
  description = "Initial storage (gp3)."
  type        = number
  default     = 50

  validation {
    condition     = var.allocated_storage_gb >= 20
    error_message = "allocated_storage_gb must be at least 20."
  }
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 500

  validation {
    condition     = var.max_allocated_storage_gb >= 20
    error_message = "max_allocated_storage_gb must be at least 20."
  }
}

variable "multi_az" {
  description = "Synchronous standby in a second zone. Required in production."
  type        = bool
  default     = false

  validation {
    condition     = var.multi_az || var.environment != "prod"
    error_message = "Production databases must be Multi-AZ."
  }
}

variable "backup_retention_days" {
  description = "Automated backup retention (point-in-time recovery window)."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 1 and 35."
  }
}

variable "deletion_protection" {
  description = "Refuse to delete the instance. Required in production."
  type        = bool
  default     = true

  validation {
    condition     = var.deletion_protection || var.environment != "prod"
    error_message = "Production databases must keep deletion protection on."
  }
}

variable "oidc_provider_arn" {
  description = "IAM OIDC provider of the EKS cluster (for the backup role trust policy)."
  type        = string
}

variable "oidc_issuer" {
  description = "OIDC issuer without https://."
  type        = string
}

variable "backup_namespace" {
  description = "Kubernetes namespace of the in-cluster PostgreSQL (CloudNativePG) allowed to write backups."
  type        = string
}

variable "backup_service_account" {
  description = "ServiceAccount of the CloudNativePG cluster (it is named after the Cluster resource)."
  type        = string
  default     = "system-db"
}

variable "backup_retention_days_object_store" {
  description = "Days after which expired noncurrent backup objects are removed."
  type        = number
  default     = 35

  validation {
    condition     = var.backup_retention_days_object_store >= 7
    error_message = "Keep backup objects for at least 7 days."
  }
}

variable "tags" {
  description = "Tags merged onto every resource."
  type        = map(string)
  default     = {}
}

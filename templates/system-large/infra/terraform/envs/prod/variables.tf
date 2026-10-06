variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "region must look like eu-west-1."
  }
}

variable "owner" {
  description = "Team or person tagged as owner on every resource."
  type        = string
  default     = "platform-team"
}

variable "admin_principal_arns" {
  description = "IAM role or user ARNs that get cluster-admin on the production cluster."
  type        = list(string)
  default     = []
}

variable "create_rds" {
  description = "Create the managed RDS instance. Set false to run the database in the cluster with CloudNativePG (deploy/kustomize/base/db-cluster.yaml); the backup bucket and role are created either way."
  type        = bool
  default     = true
}

variable "availability_zones" {
  description = "Availability zone names to use (pinned on purpose: a data source listing all zones would silently grow when AWS adds one)."
  type        = list(string)
  default     = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]

  validation {
    condition     = length(var.availability_zones) >= 3 && length(var.availability_zones) <= 3
    error_message = "Use three availability zones."
  }
}

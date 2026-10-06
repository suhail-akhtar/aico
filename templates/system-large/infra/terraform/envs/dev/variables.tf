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
  description = "IAM role or user ARNs that get cluster-admin on the development cluster."
  type        = list(string)
  default     = []
}

variable "public_access_cidrs" {
  description = "CIDRs that may reach the Kubernetes API publicly (the office or VPN egress). Empty keeps the API private."
  type        = list(string)
  default     = []
}

variable "create_rds" {
  description = "Create an RDS instance. Development normally runs CloudNativePG in the cluster, so this is off."
  type        = bool
  default     = false
}

variable "availability_zones" {
  description = "Availability zone names to use (pinned on purpose: a data source listing all zones would silently grow when AWS adds one)."
  type        = list(string)
  default     = ["eu-west-1a", "eu-west-1b"]

  validation {
    condition     = length(var.availability_zones) >= 2 && length(var.availability_zones) <= 3
    error_message = "Use two or three availability zones."
  }
}

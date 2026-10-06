variable "name" {
  description = "Name prefix for every resource (for example system-dev)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name must be 3-32 characters of lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "cidr" {
  description = "IPv4 CIDR of the VPC. The subnet layout assumes a /16."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.cidr, 0)) && tonumber(split("/", var.cidr)[1]) == 16
    error_message = "cidr must be a valid IPv4 CIDR with a /16 prefix."
  }
}

variable "availability_zones" {
  description = "Availability zones to spread over (two or three). One public, one private and one database subnet per zone."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2 && length(var.availability_zones) <= 3
    error_message = "Use two or three availability zones."
  }
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheap, a single point of failure: development) instead of one per zone (production)."
  type        = bool
  default     = false
}

variable "flow_log_retention_days" {
  description = "Retention of the VPC flow log group."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.flow_log_retention_days)
    error_message = "flow_log_retention_days must be a retention value CloudWatch Logs accepts."
  }
}

variable "cluster_name" {
  description = "Name of the EKS cluster that will use the subnets (for the discovery tags)."
  type        = string
}

variable "tags" {
  description = "Tags merged onto every resource."
  type        = map(string)
  default     = {}
}

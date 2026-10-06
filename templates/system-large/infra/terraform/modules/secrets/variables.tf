variable "name" {
  description = "Name prefix for the IAM role and the KMS key (for example system-prod)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name must be 3-32 characters of lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "dev, staging or prod: the secret names are system/<environment>/<service>."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "secret_names" {
  description = "Service secrets to create (empty containers: the values are written out of band). Must match the remote keys in deploy/helm and deploy/kustomize."
  type        = set(string)
  default     = ["api", "db-backup"]

  validation {
    condition     = alltrue([for s in var.secret_names : can(regex("^[a-z][a-z0-9-]*$", s))])
    error_message = "Secret names are lowercase letters, digits and hyphens."
  }
}

variable "recovery_window_days" {
  description = "Days a deleted secret can be restored. 7 or more outside throwaway environments."
  type        = number
  default     = 30

  validation {
    condition     = var.recovery_window_days == 0 || (var.recovery_window_days >= 7 && var.recovery_window_days <= 30)
    error_message = "recovery_window_days must be 0 (immediate delete) or between 7 and 30."
  }
}

variable "oidc_provider_arn" {
  description = "IAM OIDC provider of the EKS cluster."
  type        = string
}

variable "oidc_issuer" {
  description = "OIDC issuer without https://."
  type        = string
}

variable "external_secrets_namespace" {
  description = "Namespace of External Secrets Operator."
  type        = string
  default     = "external-secrets"
}

variable "external_secrets_service_account" {
  description = "ServiceAccount of External Secrets Operator."
  type        = string
  default     = "external-secrets"
}

variable "tags" {
  description = "Tags merged onto every resource."
  type        = map(string)
  default     = {}
}

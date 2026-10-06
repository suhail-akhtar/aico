output "cluster_name" {
  description = "EKS cluster name: aws eks update-kubeconfig --name <this>."
  value       = module.k8s.cluster_name
}

output "external_secrets_role_arn" {
  description = "Annotate the external-secrets ServiceAccount with this (eks.amazonaws.com/role-arn)."
  value       = module.secrets.external_secrets_role_arn
}

output "secret_names" {
  description = "Empty Secrets Manager secrets to populate out of band."
  value       = module.secrets.secret_names
}

output "backup_bucket" {
  description = "Bucket for CloudNativePG backups."
  value       = module.db.backup_bucket
}

output "backup_role_arn" {
  description = "IRSA role for the CloudNativePG ServiceAccount."
  value       = module.db.backup_role_arn
}

output "rds_endpoint" {
  description = "RDS endpoint when create_rds is true, otherwise null."
  value       = module.db.endpoint
}

output "secret_arns" {
  description = "ARN of each (empty) Secrets Manager secret, keyed by name."
  value       = { for k, s in aws_secretsmanager_secret.service : k => s.arn }
}

output "secret_names" {
  description = "Secret names, which are the remote keys the ExternalSecrets read."
  value       = [for s in aws_secretsmanager_secret.service : s.name]
}

output "external_secrets_role_arn" {
  description = "IAM role to annotate on the external-secrets ServiceAccount (eks.amazonaws.com/role-arn)."
  value       = aws_iam_role.external_secrets.arn
}

output "kms_key_arn" {
  description = "KMS key encrypting the secrets."
  value       = aws_kms_key.secrets.arn
}

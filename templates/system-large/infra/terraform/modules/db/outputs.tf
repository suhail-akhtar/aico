output "endpoint" {
  description = "RDS endpoint host:port. Use it in DATABASE_URL when running on RDS instead of CloudNativePG."
  value       = one(aws_db_instance.this[*].endpoint)
}

output "master_user_secret_arn" {
  description = "ARN of the Secrets Manager secret RDS manages for the master user (the value never passes through Terraform)."
  value       = one(aws_db_instance.this[*].master_user_secret[0].secret_arn)
}

output "kms_key_arn" {
  description = "KMS key encrypting the database, its secret and the backup bucket."
  value       = aws_kms_key.db.arn
}

output "backup_bucket" {
  description = "S3 bucket for CloudNativePG WAL archives and base backups (destinationPath s3://<bucket>/)."
  value       = aws_s3_bucket.backups.bucket
}

output "backup_role_arn" {
  description = "IAM role the CloudNativePG ServiceAccount assumes (annotate the Cluster serviceAccountTemplate and set inheritFromIAMRole: true)."
  value       = aws_iam_role.backup.arn
}

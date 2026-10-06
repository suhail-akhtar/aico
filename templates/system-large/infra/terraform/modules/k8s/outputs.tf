output "cluster_name" {
  description = "EKS cluster name."
  value       = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = aws_eks_cluster.this.endpoint
}

output "cluster_certificate_authority_data" {
  description = "Base64 cluster CA certificate (public information)."
  value       = aws_eks_cluster.this.certificate_authority[0].data
}

output "cluster_security_group_id" {
  description = "Security group EKS attaches to the managed nodes; databases allow this group on 5432."
  value       = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "oidc_provider_arn" {
  description = "ARN of the IAM OIDC provider for IRSA trust policies."
  value       = aws_iam_openid_connect_provider.this.arn
}

output "oidc_issuer" {
  description = "OIDC issuer host and path without the https:// prefix, for trust policy conditions."
  value       = local.oidc_issuer
}

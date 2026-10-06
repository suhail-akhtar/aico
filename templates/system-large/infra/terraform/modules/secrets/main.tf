# Secrets Manager containers and the role that lets External Secrets Operator read them.
#
# Terraform creates the secrets EMPTY and never a secret version: a value written by Terraform
# lands in state, in plan output and in whoever's CI logs. People or a rotation job populate
# them out of band (aws secretsmanager put-secret-value ...), and the cluster reads them
# through the ClusterSecretStore "platform". Remote keys: system/<environment>/<name>, a JSON
# secret whose properties are the environment variable names (DATABASE_PASSWORD, ...).

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id
  prefix     = "system/${var.environment}"
}

resource "aws_kms_key" "secrets" {
  description             = "${var.name} application secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  # Explicit policy (account administration; IAM policies then grant use): the default key
  # policy is equivalent, but spelled out it survives review and linters.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AccountAdministration"
      Effect    = "Allow"
      Principal = { AWS = "arn:${local.partition}:iam::${local.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })

  tags = var.tags
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_secretsmanager_secret" "service" {
  for_each = var.secret_names

  name                    = "${local.prefix}/${each.value}"
  description             = "system ${var.environment} ${each.value}: JSON properties are environment variable names; value populated out of band"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = var.recovery_window_days

  tags = var.tags
}

data "aws_iam_policy_document" "external_secrets_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_issuer}:sub"
      values   = ["system:serviceaccount:${var.external_secrets_namespace}:${var.external_secrets_service_account}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "external_secrets" {
  name               = "${var.name}-external-secrets"
  assume_role_policy = data.aws_iam_policy_document.external_secrets_trust.json

  tags = var.tags
}

# Read-only, and only this environment's secrets: the dev cluster's role cannot read prod.
data "aws_iam_policy_document" "external_secrets_access" {
  statement {
    sid     = "ReadServiceSecrets"
    actions = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [
      "arn:${local.partition}:secretsmanager:${data.aws_region.current.region}:${local.account_id}:secret:${local.prefix}/*",
    ]
  }

  statement {
    sid       = "DecryptServiceSecrets"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "external_secrets" {
  name   = "read-${var.environment}-secrets"
  role   = aws_iam_role.external_secrets.id
  policy = data.aws_iam_policy_document.external_secrets_access.json
}

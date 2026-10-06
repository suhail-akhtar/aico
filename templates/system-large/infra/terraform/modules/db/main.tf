# Two things live here:
#
#  1. An RDS PostgreSQL 18 instance, for teams that run production on a managed database
#     instead of CloudNativePG in the cluster (deploy/kustomize/base/db-cluster.yaml). Point
#     the services' DATABASE_URL at its endpoint and drop the in-cluster Cluster; the
#     services are unchanged. The master password is generated and rotated by RDS in
#     Secrets Manager (manage_master_user_password): it never exists in Terraform state or
#     in git.
#  2. The object-store bucket the in-cluster database archives WAL and base backups to, and
#     an IAM role the CloudNativePG ServiceAccount assumes through IRSA (no access keys).
#
# Use one or the other for the primary database; the backup bucket is only needed with
# CloudNativePG, and costs nothing while empty.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition   = data.aws_partition.current.partition
  bucket_name = "${var.name}-db-backups-${data.aws_caller_identity.current.account_id}"
  final_snap  = var.deletion_protection ? "${var.name}-final" : null
}

resource "aws_kms_key" "db" {
  description             = "${var.name} database and backups"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  # Explicit policy (account administration; IAM policies then grant use): the default key
  # policy is equivalent, but spelled out it survives review and linters.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AccountAdministration"
      Effect    = "Allow"
      Principal = { AWS = "arn:${local.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })

  tags = var.tags
}

resource "aws_kms_alias" "db" {
  name          = "alias/${var.name}-db"
  target_key_id = aws_kms_key.db.key_id
}

# ---------------------------------------------------------------------------------------
# RDS PostgreSQL 18
# ---------------------------------------------------------------------------------------
resource "aws_db_subnet_group" "this" {
  count = var.create_instance ? 1 : 0

  name       = var.name
  subnet_ids = var.subnet_ids

  tags = var.tags
}

resource "aws_security_group" "db" {
  count = var.create_instance ? 1 : 0

  name_prefix = "${var.name}-db-"
  description = "PostgreSQL for ${var.name}: only the named client groups, no egress."
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name}-db" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "from_clients" {
  for_each = var.create_instance ? toset(var.client_security_group_ids) : toset([])

  security_group_id            = aws_security_group.db[0].id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the application nodes"
}

resource "aws_db_parameter_group" "this" {
  count = var.create_instance ? 1 : 0

  name_prefix = "${var.name}-pg18-"
  family      = "postgres18"
  description = "${var.name} PostgreSQL 18"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_iam_role" "monitoring" {
  count = var.create_instance ? 1 : 0

  name = "${var.name}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  count = var.create_instance ? 1 : 0

  role       = aws_iam_role.monitoring[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  count = var.create_instance ? 1 : 0

  identifier = var.name

  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.db.arn

  db_name                       = "postgres"
  username                      = "dbadmin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.db.arn

  db_subnet_group_name   = aws_db_subnet_group.this[0].name
  vpc_security_group_ids = [aws_security_group.db[0].id]
  parameter_group_name   = aws_db_parameter_group.this[0].name
  publicly_accessible    = false
  multi_az               = var.multi_az

  backup_retention_period   = var.backup_retention_days
  backup_window             = "02:00-03:00"
  maintenance_window        = "sun:04:00-sun:05:00"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = local.final_snap

  auto_minor_version_upgrade          = true
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]

  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.db.arn
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.monitoring[0].arn

  tags = var.tags

  depends_on = [aws_iam_role_policy_attachment.monitoring]
}

# ---------------------------------------------------------------------------------------
# Backup bucket for the in-cluster database (CloudNativePG, Barman)
# ---------------------------------------------------------------------------------------
resource "aws_s3_bucket" "backups" {
  bucket = local.bucket_name

  tags = var.tags
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.db.arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = var.backup_retention_days_object_store
    }
  }
}

data "aws_iam_policy_document" "backups_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = data.aws_iam_policy_document.backups_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.backups]
}

data "aws_iam_policy_document" "backup_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_issuer}:sub"
      values   = ["system:serviceaccount:${var.backup_namespace}:${var.backup_service_account}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name}-db-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_trust.json

  tags = var.tags
}

data "aws_iam_policy_document" "backup_access" {
  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.backups.arn]
  }

  statement {
    sid       = "ReadWriteObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }

  statement {
    sid       = "UseBackupKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.db.arn]
  }
}

resource "aws_iam_role_policy" "backup" {
  name   = "write-backups"
  role   = aws_iam_role.backup.id
  policy = data.aws_iam_policy_document.backup_access.json
}

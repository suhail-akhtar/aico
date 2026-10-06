# Production: three zones, one NAT gateway per zone, on-demand nodes, a private Kubernetes
# API, Multi-AZ RDS with deletion protection and two weeks of point-in-time recovery, long
# log retention. The module validations refuse a prod database that is not Multi-AZ or has
# deletion protection off, so a careless edit fails at plan time.
#
# Run the database on RDS (this file, create_rds = true) or on CloudNativePG in the cluster
# (create_rds = false); the services are unchanged either way, only DATABASE_URL moves.

locals {
  environment = "prod"
  name        = "system-${local.environment}"
}

module "network" {
  source = "../../modules/network"

  name                    = local.name
  cluster_name            = local.name
  availability_zones      = var.availability_zones
  single_nat_gateway      = false
  flow_log_retention_days = 365
}

module "k8s" {
  source = "../../modules/k8s"

  name                   = local.name
  subnet_ids             = module.network.private_subnet_ids
  endpoint_public_access = false
  admin_principal_arns   = var.admin_principal_arns
  node_instance_types    = ["m7i.xlarge"]
  node_capacity_type     = "ON_DEMAND"
  node_min_size          = 3
  node_max_size          = 12
  node_desired_size      = 3
  node_disk_size_gb      = 100
  log_retention_days     = 365
}

module "db" {
  source = "../../modules/db"

  name                      = local.name
  environment               = local.environment
  create_instance           = var.create_rds
  vpc_id                    = module.network.vpc_id
  subnet_ids                = module.network.database_subnet_ids
  client_security_group_ids = [module.k8s.cluster_security_group_id]
  instance_class            = "db.m7g.xlarge"
  allocated_storage_gb      = 200
  max_allocated_storage_gb  = 2000
  multi_az                  = true
  backup_retention_days     = 14
  deletion_protection       = true
  oidc_provider_arn         = module.k8s.oidc_provider_arn
  oidc_issuer               = module.k8s.oidc_issuer
  backup_namespace          = "system-prod"
}

module "secrets" {
  source = "../../modules/secrets"

  name                 = local.name
  environment          = local.environment
  recovery_window_days = 30
  oidc_provider_arn    = module.k8s.oidc_provider_arn
  oidc_issuer          = module.k8s.oidc_issuer
}

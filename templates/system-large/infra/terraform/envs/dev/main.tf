# Development: the smallest cluster that behaves like production. One NAT gateway, two zones,
# two small nodes, no RDS (CloudNativePG runs the database in the cluster), the Kubernetes
# API private unless an allow-list is given. Same modules as prod: only the numbers differ.

locals {
  environment = "dev"
  name        = "system-${local.environment}"
}

module "network" {
  source = "../../modules/network"

  name                    = local.name
  cluster_name            = local.name
  availability_zones      = var.availability_zones
  single_nat_gateway      = true
  flow_log_retention_days = 30
}

module "k8s" {
  source = "../../modules/k8s"

  name                   = local.name
  subnet_ids             = module.network.private_subnet_ids
  endpoint_public_access = length(var.public_access_cidrs) > 0
  public_access_cidrs    = var.public_access_cidrs
  admin_principal_arns   = var.admin_principal_arns
  node_instance_types    = ["m7i.large"]
  node_capacity_type     = "SPOT"
  node_min_size          = 2
  node_max_size          = 4
  node_desired_size      = 2
  log_retention_days     = 30
}

module "db" {
  source = "../../modules/db"

  name                      = local.name
  environment               = local.environment
  create_instance           = var.create_rds
  vpc_id                    = module.network.vpc_id
  subnet_ids                = module.network.database_subnet_ids
  client_security_group_ids = [module.k8s.cluster_security_group_id]
  multi_az                  = false
  backup_retention_days     = 7
  deletion_protection       = false
  oidc_provider_arn         = module.k8s.oidc_provider_arn
  oidc_issuer               = module.k8s.oidc_issuer
  backup_namespace          = "system-dev"
}

module "secrets" {
  source = "../../modules/secrets"

  name                 = local.name
  environment          = local.environment
  recovery_window_days = 7
  oidc_provider_arn    = module.k8s.oidc_provider_arn
  oidc_issuer          = module.k8s.oidc_issuer
}

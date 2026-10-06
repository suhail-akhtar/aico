provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "system"
      Environment = "prod"
      ManagedBy   = "terraform"
      Owner       = var.owner
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "system"
      Environment = "dev"
      ManagedBy   = "terraform"
      Owner       = var.owner
    }
  }
}

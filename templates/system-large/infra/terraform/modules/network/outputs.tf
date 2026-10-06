output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC CIDR block."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet ids (load balancers, NAT)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet ids (EKS nodes)."
  value       = aws_subnet.private[*].id
}

output "database_subnet_ids" {
  description = "Database subnet ids (no route to the internet)."
  value       = aws_subnet.database[*].id
}

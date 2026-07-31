/**
 * ECS Cluster module — Fargate cluster with Container Insights, capacity
 * providers, and a Cloud Map namespace for Service Connect mTLS.
 *
 * Capacity providers:
 *   FARGATE         — always present; base tasks run here for stability.
 *   FARGATE_SPOT    — optional; enabled for non-production via enable_fargate_spot.
 *                     Spot interruption is tolerable for stateless request handlers
 *                     but must not be used for payment-service in production.
 *
 * Service Connect:
 *   An HTTP Cloud Map namespace is created per cluster. All ECS services in
 *   the cluster that opt into Service Connect receive a sidecar proxy that
 *   routes east-west traffic over mTLS without application changes.
 *
 * Container Insights:
 *   Enabled for all environments — metric cost is negligible; the data is
 *   essential for debugging production incidents.
 */

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  cluster_name           = var.cluster_name != "" ? var.cluster_name : "${var.environment}-travel-platform"
  namespace_name         = var.service_connect_namespace_name != "" ? var.service_connect_namespace_name : "${var.environment}.travel.internal"
}

# ── ECS Cluster ───────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(var.common_tags, {
    Name        = local.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

# ── Capacity providers ────────────────────────────────────────────────────────

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = var.enable_fargate_spot ? ["FARGATE", "FARGATE_SPOT"] : ["FARGATE"]

  # Default strategy: base tasks on FARGATE; overflow to FARGATE_SPOT when enabled.
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = var.fargate_weight
    base              = var.fargate_base
  }

  dynamic "default_capacity_provider_strategy" {
    for_each = var.enable_fargate_spot ? [1] : []
    content {
      capacity_provider = "FARGATE_SPOT"
      weight            = var.fargate_spot_weight
      base              = 0
    }
  }
}

# ── Cloud Map namespace for Service Connect ───────────────────────────────────
#
# HTTP namespace (not DNS) is recommended by AWS for ECS Service Connect.
# Services reference each other by their service_connect_configuration alias;
# the ECS agent handles DNS resolution internally without Route 53 queries.

resource "aws_service_discovery_http_namespace" "service_connect" {
  name        = local.namespace_name
  description = "ECS Service Connect namespace for ${local.cluster_name} — east-west mTLS routing."

  tags = merge(var.common_tags, {
    Name        = local.namespace_name
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

/**
 * target_groups.tf — ALB target groups for api-gateway and all nine internal services.
 *
 * Target group attributes (per AC6):
 *   health_check path  : /health/ready
 *   healthy_threshold  : 2
 *   unhealthy_threshold: 3
 *   interval           : 15 s
 *   timeout            : 5 s
 *   matcher            : 200
 *
 * Target group attributes:
 *   deregistration_delay              : 30 s
 *   stickiness                        : disabled
 *   load_balancing.algorithm.type     : least_outstanding_requests
 *
 * Target group ARNs are exposed as module outputs for consumption by WO-081 ECS service definitions.
 */

locals {
  # All services including api-gateway. Port 8080 is the container listen port for every service.
  all_services = [
    "api-gateway",
    "auth-service",
    "booking-service",
    "search-service",
    "payment-service",
    "ai-service",
    "user-service",
    "itinerary-service",
    "reporting-service",
    "notification-service",
  ]
}

resource "aws_lb_target_group" "services" {
  for_each = toset(local.all_services)

  name        = "${var.environment}-${each.key}"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # Fargate tasks use awsvpc networking; register by IP, not instance.

  health_check {
    enabled             = true
    path                = "/health/ready"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  stickiness {
    enabled = false
    type    = "lb_cookie"
  }

  # Keeps the name stable across recreation so blue/green deploys work.
  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-${each.key}"
    Service = each.key
  })
}

resource "aws_lb_target_group_attribute" "deregistration_delay" {
  for_each = toset(local.all_services)

  target_group_arn = aws_lb_target_group.services[each.key].arn
  key              = "deregistration_delay.timeout_seconds"
  value            = "30"
}

resource "aws_lb_target_group_attribute" "load_balancing_algorithm" {
  for_each = toset(local.all_services)

  target_group_arn = aws_lb_target_group.services[each.key].arn
  key              = "load_balancing.algorithm.type"
  value            = "least_outstanding_requests"
}

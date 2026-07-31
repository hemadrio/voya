/**
 * alb_internal.tf — Internal Application Load Balancer.
 *
 * The internal ALB is scheme=internal, located in private application subnets,
 * and its security group (internal_alb_sg) accepts traffic only from gateway-sg.
 * This enforces the single-entry-point constraint: no service is directly
 * reachable from outside the VPC.
 *
 * Listener rules route by path prefix to the corresponding service target group.
 * An unmatched path returns a generic 404 with no backend detail (policy A10, AC7).
 *
 * Port 443 HTTPS uses the same regional ACM certificate as the public ALB.
 * Internal TLS satisfies in-transit encryption requirements within the VPC.
 */

locals {
  # Path-prefix → service routing table (AC7).
  # Priority values are spaced by 10 so operators can insert rules without renumbering.
  internal_service_routes = {
    "auth-service" = {
      path_prefix = "/v1/auth"
      priority    = 100
    }
    "booking-service" = {
      path_prefix = "/v1/bookings"
      priority    = 110
    }
    "search-service" = {
      path_prefix = "/v1/search"
      priority    = 120
    }
    "payment-service" = {
      path_prefix = "/v1/payments"
      priority    = 130
    }
    "ai-service" = {
      path_prefix = "/v1/ai"
      priority    = 140
    }
    "user-service" = {
      path_prefix = "/v1/users"
      priority    = 150
    }
    "itinerary-service" = {
      path_prefix = "/v1/itineraries"
      priority    = 160
    }
    "reporting-service" = {
      path_prefix = "/v1/reports"
      priority    = 170
    }
    "notification-service" = {
      path_prefix = "/v1/notifications"
      priority    = 180
    }
  }
}

# ── Internal ALB ─────────────────────────────────────────────────────────────

resource "aws_lb" "internal" {
  name               = "${var.environment}-internal-alb"
  internal           = true # scheme=internal — not reachable from outside the VPC (AC5)
  load_balancer_type = "application"
  security_groups    = [var.internal_alb_sg_id]
  subnets            = var.private_app_subnet_ids

  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "production" ? true : false

  tags = merge(var.common_tags, {
    Name   = "${var.environment}-internal-alb"
    Scheme = "internal"
  })
}

# ── HTTPS/443 listener ───────────────────────────────────────────────────────
#
# Default action: generic 404 — unmatched paths return no backend detail (AC7).

resource "aws_lb_listener" "internal_https" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.regional.arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      # No backend path or service name in the response (policy A10).
      message_body = "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"The requested resource was not found.\"}}"
      status_code  = "404"
    }
  }

  tags = merge(var.common_tags, {
    Name = "${var.environment}-internal-https"
  })
}

# ── Path-prefix routing rules ─────────────────────────────────────────────────

resource "aws_lb_listener_rule" "internal_service" {
  for_each = local.internal_service_routes

  listener_arn = aws_lb_listener.internal_https.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.services[each.key].arn
  }

  condition {
    path_pattern {
      values = ["${each.value.path_prefix}", "${each.value.path_prefix}/*"]
    }
  }
}

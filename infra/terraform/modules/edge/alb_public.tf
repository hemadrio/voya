/**
 * alb_public.tf — Internet-facing Application Load Balancer.
 *
 * Trust chain: CloudFront → public ALB → api-gateway target group.
 *
 * Security invariants:
 *   - HTTP/80 listener redirects to HTTPS/443 with 301.
 *   - HTTPS/443 listener uses TLS policy ELBSecurityPolicy-TLS13-1-2-2021-06
 *     (TLS 1.3 enabled; TLS 1.0/1.1 refused).
 *   - HTTPS default action: 403. Only requests bearing the CloudFront
 *     origin secret header are forwarded (prevents direct-to-ALB bypass, AC1).
 *   - Two header values are accepted simultaneously so a rotation does not
 *     cause a 403 outage during the overlap window (edge case from WO-080).
 */

# ── ACM certificate (regional — for the ALB listener) ───────────────────────

resource "aws_acm_certificate" "regional" {
  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.common_tags, {
    Name = "${var.environment}-regional-cert"
  })
}

resource "aws_route53_record" "cert_validation_regional" {
  for_each = var.route53_zone_id != "" ? {
    for dvo in aws_acm_certificate.regional.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "regional" {
  count = var.route53_zone_id != "" ? 1 : 0

  certificate_arn = aws_acm_certificate.regional.arn
  validation_record_fqdns = [
    for record in aws_route53_record.cert_validation_regional : record.fqdn
  ]
}

# ── CloudFront origin secret (two values for zero-outage rotation) ───────────
#
# Secret format (JSON): {"current":"<value>","previous":"<value>"}
# The ALB listener rule accepts EITHER value. During rotation:
#   1. Generate new value; write it to "current", move old to "previous".
#   2. Update CloudFront to send new value.
#   3. After all CloudFront POPs have adopted the new value, rotate secret again
#      so "previous" also becomes a new value (or deactivate the old one).

resource "random_password" "origin_header_current" {
  length  = 48
  special = false
  lifecycle {
    # Never regenerate after first apply — operator controls rotation.
    ignore_changes = all
  }
}

resource "random_password" "origin_header_previous" {
  length  = 48
  special = false
  lifecycle {
    ignore_changes = all
  }
}

resource "aws_secretsmanager_secret" "origin_header" {
  name                    = "${var.environment}/edge/cf-origin-secret"
  description             = "CloudFront→ALB origin secret header. JSON {current, previous} for zero-outage rotation."
  recovery_window_in_days = 7

  tags = merge(var.common_tags, {
    Name    = "${var.environment}-cf-origin-secret"
    Purpose = "CloudFront origin header anti-bypass"
  })
}

resource "aws_secretsmanager_secret_version" "origin_header" {
  secret_id = aws_secretsmanager_secret.origin_header.id
  secret_string = jsonencode({
    current  = random_password.origin_header_current.result
    previous = random_password.origin_header_previous.result
  })

  lifecycle {
    # Operator-driven rotation writes a new version; Terraform must not overwrite it.
    ignore_changes = [secret_string]
  }
}

locals {
  _origin_secret = jsondecode(aws_secretsmanager_secret_version.origin_header.secret_string)
  origin_header_current  = local._origin_secret.current
  origin_header_previous = local._origin_secret.previous
}

# ── Internet-facing ALB ──────────────────────────────────────────────────────

resource "aws_lb" "public" {
  name               = "${var.environment}-edge-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.edge_alb_sg_id]
  subnets            = var.public_subnet_ids

  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "production" ? true : false

  tags = merge(var.common_tags, {
    Name = "${var.environment}-edge-alb"
  })
}

# ── HTTP/80 → HTTPS/443 301 redirect ─────────────────────────────────────────

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = merge(var.common_tags, {
    Name = "${var.environment}-http-redirect"
  })
}

# ── HTTPS/443 listener ───────────────────────────────────────────────────────
#
# Default action is 403 — all traffic is blocked unless a listener rule
# explicitly forwards it. Only the origin-secret allow rule (priority 1) grants access.

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.regional.arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      # Message does not disclose backend identity (policy A10).
      message_body = "Forbidden"
      status_code  = "403"
    }
  }

  tags = merge(var.common_tags, {
    Name = "${var.environment}-https"
  })
}

# ── Origin-secret allow rule (priority 1) ────────────────────────────────────
#
# Forwards requests that carry the X-Origin-Secret header matching EITHER the
# current OR previous value (OR semantics within the values list).
# Anything not matching falls through to the default 403 action above.

resource "aws_lb_listener_rule" "allow_from_cloudfront" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.services["api-gateway"].arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Secret"
      values           = [local.origin_header_current, local.origin_header_previous]
    }
  }
}

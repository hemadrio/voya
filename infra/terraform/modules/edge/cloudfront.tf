/**
 * cloudfront.tf — CloudFront distribution, response headers policy,
 * and us-east-1 ACM certificate.
 *
 * The distribution fronts the public ALB. The WAF WebACL (waf.tf) is attached
 * via web_acl_id. Security headers are injected uniformly at the edge so no
 * service has to set them individually.
 *
 * Origin authentication: CloudFront sends X-Origin-Secret: <current-value> with
 * every request to the origin (public ALB). The ALB listener rule (alb_public.tf)
 * rejects requests that do not carry a recognised secret, preventing CloudFront bypass.
 *
 * Header policy (AC4):
 *   Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
 *   X-Content-Type-Options:    nosniff
 *   X-Frame-Options:           DENY
 *   Referrer-Policy:           strict-origin-when-cross-origin
 *   Content-Security-Policy:   default-src 'self'; ... (see resource below)
 */

# ── ACM certificate in us-east-1 (required for CloudFront) ───────────────────

resource "aws_acm_certificate" "cloudfront" {
  provider                  = aws.us_east_1
  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.common_tags, {
    Name = "${var.environment}-cloudfront-cert"
  })
}

resource "aws_route53_record" "cert_validation_cloudfront" {
  for_each = var.route53_zone_id != "" ? {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : dvo.domain_name => {
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

  # DNS record may be shared with the regional cert — allow_overwrite handles that.
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider = aws.us_east_1
  count    = var.route53_zone_id != "" ? 1 : 0

  certificate_arn = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [
    for record in aws_route53_record.cert_validation_cloudfront : record.fqdn
  ]
}

# ── Response headers policy (security headers injected at the edge, AC4) ─────

resource "aws_cloudfront_response_headers_policy" "security_headers" {
  name    = "${var.environment}-security-headers"
  comment = "Uniform security headers applied at CloudFront edge — WO-080"

  security_headers_config {
    # HSTS: max-age=63072000 (~2 years), includeSubDomains, preload (AC4)
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    # X-Content-Type-Options: nosniff (AC4)
    content_type_options {
      override = true
    }

    # X-Frame-Options: DENY — prevents clickjacking (AC4)
    frame_options {
      frame_option = "DENY"
      override     = true
    }

    # Referrer-Policy: strict-origin-when-cross-origin (AC4)
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    # Content-Security-Policy (AC4)
    # 'unsafe-inline' on script-src is required by Next.js App Router for hydration;
    # a nonce-based policy should replace this once the frontend CSP is hardened.
    content_security_policy {
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self' https:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ])
      override = true
    }
  }
}

# ── CloudFront distribution ───────────────────────────────────────────────────

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.environment} travel platform — WO-080"
  aliases         = [var.domain_name, "*.${var.domain_name}"]
  price_class     = "PriceClass_100" # North America + Europe

  web_acl_id = aws_wafv2_web_acl.main.arn

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.cloudfront.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # ── Origin: public ALB ────────────────────────────────────────────────────
  origin {
    origin_id   = "public-alb"
    domain_name = aws_lb.public.dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    # CloudFront → ALB authentication header (AC1).
    # The ALB listener rule allows only requests carrying this header.
    custom_header {
      name  = "X-Origin-Secret"
      value = local.origin_header_current
    }
  }

  # ── Default cache behaviour ────────────────────────────────────────────────
  default_cache_behavior {
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    target_origin_id       = "public-alb"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # Caching disabled for all API and account responses (non-cacheable by design).
    # Cache TTLs are 0 — CloudFront acts as a pass-through with WAF filtering.
    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0

    # Forward all headers, cookies, and query strings to the origin so the API
    # gateway can perform its own auth/routing logic.
    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies {
        forward = "all"
      }
    }

    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # ── Stripe webhook path ────────────────────────────────────────────────────
  # Stripe webhooks POST to /v1/payments/webhooks/stripe with a raw body and
  # HMAC-SHA256 signature. This cache behaviour passes the path through with
  # the original body untransformed so HMAC verification in payment-service
  # is not broken by header/body rewriting.
  ordered_cache_behavior {
    path_pattern           = "/v1/payments/webhooks/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "public-alb"
    viewer_protocol_policy = "https-only"
    compress               = false

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0

    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies {
        forward = "all"
      }
    }

    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
  }

  tags = var.common_tags
}

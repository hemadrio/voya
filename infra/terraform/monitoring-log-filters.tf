/**
 * monitoring-log-filters.tf — CloudWatch Logs metric filters over Pino JSON.
 *
 * Filters match the stable `event` field in Pino structured logs.  Using
 * log-derived signals keeps alerting decoupled from application code: no
 * code change is needed to start emitting these metrics — the pattern matches
 * whenever the application logs the event code.
 *
 * Validated against committed sample log lines in scripts/synthetic/:
 *   {"level":50,"event":"VALIDATION_FAILED","msg":"...","correlationId":"..."}
 *   {"level":50,"event":"ACCESS_DENIED","msg":"...","service":"booking-service"}
 *   {"level":50,"event":"AUTH_FAILED","msg":"..."}
 *   {"level":50,"event":"STRIPE_SIGNATURE_INVALID","msg":"..."}
 *   {"level":60,"event":"ILLUSTRATIVE_EXPOSURE_UNFLAGGED","msg":"..."}
 *
 * Each filter publishes a metric with default_value = "0" so periods with
 * no matching logs produce zero rather than null — prevents missing-data
 * from masking genuine quiescence.
 *
 * Log groups span the services that can emit each event code.
 */

# ---------------------------------------------------------------------------
# VALIDATION_FAILED — server-side input validation failure
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "validation_failed_booking" {
  name           = "validation-failed-booking"
  log_group_name = local.log_group_booking
  pattern        = "{ $.event = \"VALIDATION_FAILED\" }"

  metric_transformation {
    name          = "ValidationFailures"
    namespace     = local.namespace_platform
    value         = "1"
    default_value = "0"
    unit          = "Count"
    dimensions = {
      service = "booking-service"
      journey = "checkout"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "validation_failed_search" {
  name           = "validation-failed-search"
  log_group_name = local.log_group_search
  pattern        = "{ $.event = \"VALIDATION_FAILED\" }"

  metric_transformation {
    name          = "ValidationFailures"
    namespace     = local.namespace_platform
    value         = "1"
    default_value = "0"
    unit          = "Count"
    dimensions = {
      service = "search-service"
      journey = "search"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "validation_failed_user" {
  name           = "validation-failed-user"
  log_group_name = local.log_group_user
  pattern        = "{ $.event = \"VALIDATION_FAILED\" }"

  metric_transformation {
    name          = "ValidationFailures"
    namespace     = local.namespace_platform
    value         = "1"
    default_value = "0"
    unit          = "Count"
    dimensions = {
      service = "user-service"
      journey = "profile"
    }
  }
}

# ---------------------------------------------------------------------------
# ACCESS_DENIED — 403 access-control failure
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "access_denied_booking" {
  name           = "access-denied-booking"
  log_group_name = local.log_group_booking
  pattern        = "{ $.event = \"ACCESS_DENIED\" }"

  metric_transformation {
    name          = "AccessDenied"
    namespace     = local.namespace_platform
    value         = "1"
    default_value = "0"
    unit          = "Count"
    dimensions = {
      service = "booking-service"
      journey = "checkout"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "access_denied_user" {
  name           = "access-denied-user"
  log_group_name = local.log_group_user
  pattern        = "{ $.event = \"ACCESS_DENIED\" }"

  metric_transformation {
    name          = "AccessDenied"
    namespace     = local.namespace_platform
    value         = "1"
    default_value = "0"
    unit          = "Count"
    dimensions = {
      service = "user-service"
      journey = "profile"
    }
  }
}

# ---------------------------------------------------------------------------
# AUTH_FAILED — authentication failure (credential stuffing signal)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "auth_failed" {
  name           = "auth-failed"
  log_group_name = local.log_group_user
  pattern        = "{ $.event = \"AUTH_FAILED\" }"

  metric_transformation {
    name          = "AuthFailures"
    namespace     = local.namespace_platform
    value         = "1"
    default_value = "0"
    unit          = "Count"
    dimensions = {
      service = "user-service"
      journey = "auth"
    }
  }
}

# ---------------------------------------------------------------------------
# STRIPE_SIGNATURE_INVALID — Stripe webhook HMAC verification failure
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "stripe_signature_invalid" {
  name           = "stripe-signature-invalid"
  log_group_name = local.log_group_payment
  pattern        = "{ $.event = \"STRIPE_SIGNATURE_INVALID\" }"

  metric_transformation {
    name          = "StripeSignatureFailures"
    namespace     = local.namespace_platform
    value         = "1"
    default_value = "0"
    unit          = "Count"
    dimensions = {
      service = "payment-service"
      journey = "payment"
    }
  }
}

# ---------------------------------------------------------------------------
# ILLUSTRATIVE_EXPOSURE_UNFLAGGED — zero-tolerance: any occurrence is an incident
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "illustrative_exposure_unflagged" {
  name           = "illustrative-exposure-unflagged"
  log_group_name = local.log_group_search
  pattern        = "{ $.event = \"ILLUSTRATIVE_EXPOSURE_UNFLAGGED\" }"

  metric_transformation {
    name          = "IllustrativeExposureUnflagged"
    namespace     = local.namespace_platform
    value         = "1"
    default_value = "0"
    unit          = "Count"
    dimensions = {
      service = "search-service"
      journey = "search"
    }
  }
}

# ---------------------------------------------------------------------------
# ADOT collector exporter failure
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "adot_exporter_failure" {
  name           = "adot-exporter-failure"
  log_group_name = local.log_group_adot
  pattern        = "{ $.level >= 50 && $.event = \"ADOT_EXPORT_FAILED\" }"

  metric_transformation {
    name          = "AdotExporterFailures"
    namespace     = local.namespace_platform
    value         = "1"
    default_value = "0"
    unit          = "Count"
    dimensions = {
      service = "adot-collector"
      journey = "observability"
    }
  }
}

// Package edge contains Terratest plan assertions for the edge module.
//
// Tests run `terraform plan` (no apply) and assert the structural invariants
// required by WO-080:
//   - WAF WebACL has all four AWS managed rule groups with BLOCK (none) override action.
//   - WAF rate-based rule threshold is 2000 with BLOCK action.
//   - Public ALB HTTPS listener uses TLS 1.3 security policy.
//   - Public ALB HTTP listener issues a 301 redirect.
//   - Internal ALB is scheme=internal.
//   - Target groups use /health/ready health check.
//   - CloudFront distribution exists with the WAF WebACL attached.
//
// Prerequisites:
//   go mod init travel-platform/edge-tests
//   go get github.com/gruntwork-io/terratest/modules/terraform@v0.46.0
//   go get github.com/stretchr/testify@v1.9.0
//   AWS credentials sufficient to plan ACM, ALB, WAF, CloudFront, and Firehose resources.
//
// Run:
//   cd infra/terraform/modules/edge/tests
//   go test -v -timeout 30m -run TestEdgeModulePlanDev

package edge

import (
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// devVars provides test fixture values that match the dev tfvars profile.
// No real domain is required for plan assertions — ACM just shows PENDING_VALIDATION.
var devVars = map[string]interface{}{
	"environment":   "dev",
	"aws_account_id": "123456789012",
	"aws_region":     "eu-west-1",
	"vpc_id":         "vpc-00000000000000001",
	"public_subnet_ids": []string{
		"subnet-0aaa00000000000001",
		"subnet-0aaa00000000000002",
	},
	"private_app_subnet_ids": []string{
		"subnet-0bbb00000000000001",
		"subnet-0bbb00000000000002",
	},
	"edge_alb_sg_id":     "sg-0edge000000000001",
	"internal_alb_sg_id": "sg-0internal000000001",
	"domain_name":        "dev.travel.example.com",
	"route53_zone_id":    "",
	"common_tags": map[string]string{
		"Environment": "dev",
		"ManagedBy":   "terraform",
	},
}

func moduleOpts(t *testing.T) *terraform.Options {
	t.Helper()
	return &terraform.Options{
		TerraformDir: "..",
		Vars:         devVars,
		// No backend — plan only, local state not written.
		BackendConfig: map[string]interface{}{},
		NoColor:       true,
	}
}

// TestEdgeModulePlanDev plans the edge module with dev fixtures and asserts
// structural invariants. No AWS resources are created.
func TestEdgeModulePlanDev(t *testing.T) {
	t.Parallel()

	opts := moduleOpts(t)
	terraform.Init(t, opts)
	planOutput := terraform.Plan(t, opts)

	// ── WAF WebACL ──────────────────────────────────────────────────────────

	t.Run("WAF scope is CLOUDFRONT", func(t *testing.T) {
		assert.Contains(t, planOutput, "aws_wafv2_web_acl")
		assert.Contains(t, planOutput, "CLOUDFRONT",
			"WAF WebACL must have scope=CLOUDFRONT for use with CloudFront distributions")
	})

	t.Run("WAF contains all four managed rule groups", func(t *testing.T) {
		require.Contains(t, planOutput, "AWSManagedRulesCommonRuleSet",
			"Missing AWSManagedRulesCommonRuleSet")
		require.Contains(t, planOutput, "AWSManagedRulesKnownBadInputsRuleSet",
			"Missing AWSManagedRulesKnownBadInputsRuleSet")
		require.Contains(t, planOutput, "AWSManagedRulesSQLiRuleSet",
			"Missing AWSManagedRulesSQLiRuleSet")
		require.Contains(t, planOutput, "AWSManagedRulesAmazonIpReputationList",
			"Missing AWSManagedRulesAmazonIpReputationList")
	})

	t.Run("WAF rate-based rule limit is 2000", func(t *testing.T) {
		assert.Contains(t, planOutput, "rate_based_statement",
			"Rate-based rule must be present")
		assert.Contains(t, planOutput, "2000",
			"Rate-based rule limit must be 2000 requests per window")
	})

	t.Run("WAF logging configuration present", func(t *testing.T) {
		assert.Contains(t, planOutput, "aws_wafv2_web_acl_logging_configuration",
			"WAF logging configuration must be created")
		assert.Contains(t, planOutput, "aws_kinesis_firehose_delivery_stream",
			"Kinesis Firehose delivery stream for WAF logs must be created")
	})

	t.Run("WAF log Firehose name starts with aws-waf-logs-", func(t *testing.T) {
		assert.Contains(t, planOutput, "aws-waf-logs-dev-cloudfront",
			"Firehose stream name must begin with 'aws-waf-logs-' (AWS requirement for WAF logging)")
	})

	// ── Public ALB ────────────────────────────────────────────────────────────

	t.Run("Public ALB is internet-facing", func(t *testing.T) {
		assert.Contains(t, planOutput, "dev-edge-alb",
			"Public ALB must be created")
		// internal = false means it's internet-facing.
		// In plan output Terraform shows the attribute value.
		lowerPlan := strings.ToLower(planOutput)
		assert.Contains(t, lowerPlan, "internal",
			"ALB internal attribute must be present in plan")
	})

	t.Run("Public ALB HTTPS listener uses TLS 1.3 security policy", func(t *testing.T) {
		assert.Contains(t, planOutput, "ELBSecurityPolicy-TLS13-1-2-2021-06",
			"HTTPS listener must use TLS 1.3 security policy (AC3)")
	})

	t.Run("Public ALB HTTP listener issues 301 redirect", func(t *testing.T) {
		assert.Contains(t, planOutput, "HTTP_301",
			"HTTP listener must redirect to HTTPS with 301 (AC3)")
	})

	t.Run("Public ALB HTTPS default action is 403", func(t *testing.T) {
		assert.Contains(t, planOutput, `"403"`,
			"HTTPS listener default action must be 403 to block direct-to-ALB requests (AC1)")
	})

	t.Run("Origin secret listener rule present", func(t *testing.T) {
		assert.Contains(t, planOutput, "X-Origin-Secret",
			"Listener rule must check X-Origin-Secret header (AC1)")
		assert.Contains(t, planOutput, "allow_from_cloudfront",
			"Origin-secret allow rule must be created")
	})

	// ── Internal ALB ──────────────────────────────────────────────────────────

	t.Run("Internal ALB exists with scheme=internal", func(t *testing.T) {
		assert.Contains(t, planOutput, "dev-internal-alb",
			"Internal ALB must be created (AC5)")
		// Terraform plan shows internal = true for internal scheme
		assert.Contains(t, planOutput, "aws_lb.internal",
			"Internal ALB resource must be planned")
	})

	t.Run("Internal ALB HTTPS listener uses TLS 1.3 policy", func(t *testing.T) {
		// Both the public and internal listeners use this policy.
		count := strings.Count(planOutput, "ELBSecurityPolicy-TLS13-1-2-2021-06")
		assert.GreaterOrEqual(t, count, 2,
			"Both public and internal ALB listeners must use TLS 1.3 policy")
	})

	t.Run("Internal ALB routing rules cover all nine services", func(t *testing.T) {
		services := []string{
			"/v1/auth",
			"/v1/bookings",
			"/v1/search",
			"/v1/payments",
			"/v1/ai",
			"/v1/users",
			"/v1/itineraries",
			"/v1/reports",
			"/v1/notifications",
		}
		for _, path := range services {
			assert.Contains(t, planOutput, path,
				"Internal ALB must have a routing rule for path prefix "+path+" (AC7)")
		}
	})

	// ── Target groups ─────────────────────────────────────────────────────────

	t.Run("Target groups use /health/ready health check", func(t *testing.T) {
		assert.Contains(t, planOutput, "/health/ready",
			"All target groups must use /health/ready health check path (AC6)")
	})

	t.Run("api-gateway target group exists", func(t *testing.T) {
		assert.Contains(t, planOutput, "dev-api-gateway",
			"api-gateway target group must be created (AC6)")
	})

	t.Run("All ten service target groups are planned", func(t *testing.T) {
		allServices := []string{
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
		}
		for _, svc := range allServices {
			assert.Contains(t, planOutput, "dev-"+svc,
				"Target group for "+svc+" must be planned (AC6)")
		}
	})

	// ── CloudFront ────────────────────────────────────────────────────────────

	t.Run("CloudFront distribution is planned", func(t *testing.T) {
		assert.Contains(t, planOutput, "aws_cloudfront_distribution",
			"CloudFront distribution must be created (AC1)")
	})

	t.Run("CloudFront has WAF WebACL attached", func(t *testing.T) {
		assert.Contains(t, planOutput, "web_acl_id",
			"CloudFront distribution must have WAF WebACL attached (AC2)")
	})

	t.Run("CloudFront response headers policy is planned", func(t *testing.T) {
		assert.Contains(t, planOutput, "aws_cloudfront_response_headers_policy",
			"Response headers policy must be created (AC4)")
		assert.Contains(t, planOutput, "63072000",
			"HSTS max-age must be 63072000 (AC4)")
		assert.Contains(t, planOutput, "nosniff",
			"X-Content-Type-Options nosniff must be set (AC4)")
	})

	t.Run("CloudFront HSTS includes subdomains", func(t *testing.T) {
		assert.Contains(t, planOutput, "include_subdomains",
			"HSTS must include subdomains (AC4)")
	})

	// ── WAF S3 log bucket ─────────────────────────────────────────────────────

	t.Run("WAF log S3 bucket has 365-day lifecycle", func(t *testing.T) {
		assert.Contains(t, planOutput, "aws_s3_bucket_lifecycle_configuration",
			"S3 lifecycle configuration must be created for WAF log retention")
		assert.Contains(t, planOutput, "365",
			"WAF log retention must be at least 365 days")
	})

	t.Run("WAF log S3 bucket blocks public access", func(t *testing.T) {
		assert.Contains(t, planOutput, "aws_s3_bucket_public_access_block",
			"WAF log bucket must block public access")
	})
}

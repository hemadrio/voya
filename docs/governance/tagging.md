# AWS Resource Tag Taxonomy

**WO-089 — Cost allocation tag taxonomy, budgets, and spend reporting**
**Owner:** Platform team
**Review cadence:** Quarterly (aligned with cost-model review)
**Enforcement:** Blocking pipeline policy check (`tag:policy-check` stage)

---

## Mandatory Tag Contract

Every taggable AWS resource in the travel-platform workload account **must** carry all five mandatory tags. The tags are applied uniformly via the `provider "aws" { default_tags {} }` block in each environment's `backend.tf`, which was introduced in WO-079.

| Tag key | Purpose | Example values |
|---|---|---|
| `Service` | Top-level platform component | see [Permitted values — Service](#permitted-values--service) |
| `Environment` | Deployment environment | `dev`, `staging`, `production`, `load-test` |
| `CostCentre` | Billing cost-centre identifier | `platform-prod`, `platform-staging`, `platform-dev` |
| `Owner` | Team responsible for the resource | `platform-team` |
| `DataClassification` | Sensitivity tier of data processed | see [Permitted values — DataClassification](#permitted-values--dataclassification) |

---

## Permitted Values

### Service

The `Service` tag enumerates the ten platform components plus `shared` for cross-cutting infrastructure.

| Value | Description |
|---|---|
| `travel-platform` | Default; used for shared/cross-cutting infrastructure |
| `booking-service` | Core booking orchestration |
| `auth-service` | Authentication and authorisation |
| `payment-service` | Payment processing |
| `user-service` | User profile management |
| `itinerary-service` | Itinerary building and retrieval |
| `reporting-service` | Analytics and reporting |
| `notification-service` | Email, push, and in-app notifications |
| `supplier-adapter` | Third-party supplier integrations |
| `ai-assistant` | AI-powered travel assistant |
| `shared` | Infrastructure shared across multiple services (VPC, KMS, RDS cluster) |

### Environment

| Value | Description |
|---|---|
| `dev` | Developer sandbox; synthetic data only |
| `staging` | Pre-production integration environment; synthetic data only |
| `production` | Live customer-facing environment |
| `load-test` | Speedscale replay environment for peak-load tests; separate cost centre, synthetic data only |

### CostCentre

| Value | Description |
|---|---|
| `platform-prod` | Production environment spend |
| `platform-staging` | Staging environment spend |
| `platform-dev` | Development environment spend |
| `platform-load-test` | Load-testing environment spend |

### Owner

| Value | Description |
|---|---|
| `platform-team` | Default owner for all resources in this workload account |

Additional values may be added as team ownership is delegated. Values must be kebab-case.

### DataClassification

| Value | Description |
|---|---|
| `Public` | No sensitivity; publicly reachable content |
| `Internal` | Internal-only; not customer-facing |
| `Confidential` | Contains or processes customer PII or financial data |
| `Restricted` | Highest sensitivity; payment card data, cryptographic keys |
| `Synthetic` | Non-production synthetic data only (dev and staging) |

---

## Validation Rules

Tag values are validated by the Terraform `tags` variable in each environment's `variables.tf`. The schema is:

```hcl
variable "tags" {
  type = object({
    Service            = string
    Environment        = string
    CostCentre         = string
    Owner              = string
    DataClassification = string
  })
}
```

Additional validation constraints (applied via `validation` blocks in `variables.tf`):
- All values must be non-empty strings.
- Values may contain letters, digits, hyphens, underscores, spaces, and dots. AWS tag values are limited to 256 characters.
- `Environment` must be one of: `dev`, `staging`, `production`, `load-test`.

---

## Inheritance Model

All five tags are applied via `provider "aws" { default_tags { tags = var.tags } }` in each environment's `backend.tf`. This means:

1. **Every resource that supports provider `default_tags`** receives all five tags automatically; explicit per-resource `tags = {}` blocks are used only for resource-specific supplemental tags.
2. **Resources that do not inherit provider `default_tags`** (see [Non-Taggable Resources](#non-taggable-resources) below) are exempt from the mandatory tag check. These are tracked in the allow-list maintained in `tools/ci/tag-policy.ts`.
3. **Resources created outside Terraform** (e.g., ECS-managed Service Connect artefacts) may appear untagged in Cost Explorer. These are documented in `docs/governance/cost-report.md` as the irreducible untagged remainder.

The `tags_all` attribute in the Terraform plan JSON reflects the merged result of `default_tags` plus any resource-level `tags`, and is the authoritative source checked by `tools/ci/tag-policy.ts`.

---

## Non-Taggable Resources

The following AWS resource types do not accept tags or do not inherit provider `default_tags`. They are maintained in the `NON_TAGGABLE_RESOURCE_TYPES` allow-list in `tools/ci/tag-policy.ts` and are exempt from the pipeline tag check:

- `aws_iam_role_policy` / `aws_iam_role_policy_attachment` — IAM inline policies and attachments
- `aws_route`, `aws_route_table_association`, `aws_subnet_route_table_association`, `aws_main_route_table_association` — VPC routing resources
- `aws_acm_certificate_validation` — ACM DNS validation record
- `aws_security_group_rule` — deprecated security group rule (no tag support)
- `aws_lb_listener_certificate`, `aws_lb_target_group_attachment` — load balancer attachments
- `aws_cloudwatch_log_subscription_filter` — CloudWatch subscription filter
- `aws_lambda_permission` — Lambda resource-based policy
- `aws_appautoscaling_policy` — Application Auto Scaling policy (target has tags; policy does not)
- `aws_autoscaling_attachment` — Auto Scaling group attachment
- `aws_wafv2_web_acl_association`, `aws_wafv2_web_acl_logging_configuration` — WAF associations
- Non-AWS providers: `null_resource`, `terraform_data`, `random_*`, `time_*`, `tls_*`

**To add a new exemption:** Open a PR modifying `NON_TAGGABLE_RESOURCE_TYPES` in `tools/ci/tag-policy.ts` with a comment explaining why the resource type does not support tags, and link the AWS documentation confirming it.

---

## Pipeline Enforcement

The `tag:policy-check` stage in `forge/pipeline.yml` runs after `tf-plan-staging` and `tf-plan-production`. It:

1. Reads the binary Terraform plan files (`tfplan.staging`, `tfplan.production`).
2. Runs `terraform show -json` to convert each plan to JSON.
3. Pipes the JSON to `npx tsx tools/ci/tag-policy.ts`, which exits non-zero if any taggable resource is created or updated without all five mandatory tags.
4. Names the specific resource address and missing tag keys in the failure output.

**The check is blocking.** A PR that introduces an untagged taggable resource will fail the pipeline. Exemptions must be added to `NON_TAGGABLE_RESOURCE_TYPES` with justification, not by suppressing the check.

---

## Cost Allocation Tag Activation (Manual Step)

Cost allocation tags must be activated in the AWS Billing and Cost Management console in the **billing account** before they appear as selectable dimensions in Cost Explorer. Terraform in the workload account cannot perform this action.

**Verification procedure (run once per new tag key):**

1. Sign in to the AWS billing account (not the workload account).
2. Navigate to **Billing and Cost Management → Cost allocation tags**.
3. Find each of the five tag keys (`Service`, `Environment`, `CostCentre`, `Owner`, `DataClassification`) in the **User-defined cost allocation tags** section.
4. Select all five and click **Activate**.
5. Wait up to 24 hours for tags to propagate into Cost Explorer dimensions.
6. Verify by opening **Cost Explorer → Filters → Tags** and confirming all five keys appear.

**Expected lag:** Newly activated tags take up to 24 hours to appear in Cost Explorer. The first per-service spend report may be incomplete during this window — see `docs/governance/cost-report.md` for the expected lag documentation.

---

## Review Cadence

| Frequency | Action |
|---|---|
| Quarterly | Review permitted values list against actual deployed services; update if new components have been added |
| On each new service launch | Add the service `Service` tag value and verify `CostCentre` allocation |
| On each environment change | Update `Environment` and `CostCentre` permitted values |
| After each Cost Explorer report | Review untagged spend, identify sources, add to allow-list or fix tagging |

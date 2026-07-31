# Per-Service Cost Report

**WO-089 — Cost allocation tag taxonomy, budgets, and spend reporting**
**Owner:** Platform team
**Report frequency:** Monthly (first business day after month-end)
**Related:** [tagging.md](tagging.md), [AWS Cost Explorer](https://console.aws.amazon.com/cost-management/home)

---

## Overview

This document defines the repeatable per-service spend query run against AWS Cost Explorer
grouped by the `Service` tag, the untagged-spend view used to drive untagged spend toward
zero, and the baseline output committed to this repository.

All spend figures reference the travel-platform workload account. Load-testing spend is
tracked separately under the `load-test` Environment tag and is not mixed into the
production service totals.

---

## Monthly Per-Service Spend Report

### Cost Explorer Query (Console)

1. Open [AWS Cost Explorer](https://console.aws.amazon.com/cost-management/home#/cost-explorer).
2. Set **Date range**: previous calendar month (e.g., June 1–June 30).
3. Set **Granularity**: Monthly.
4. Set **Group by**: Tag → `Service`.
5. Set **Filter**: Tag → `Environment` → `production` (exclude `load-test` and lower envs).
6. Click **Apply**.

The resulting breakdown shows spend per `Service` tag value. Compare against the documented
cost model:

| Service (tag value) | Approximate monthly budget |
|---|---|
| `travel-platform` (shared infrastructure) | combined in per-line budgets |
| Fargate / ECS total | ~$1,150 |
| RDS total | ~$470 |
| ElastiCache total | ~$210 |
| Edge (ALB + CloudFront + WAF) | ~$190 |
| NAT Gateway | ~$100 |
| Other (SQS, SES, S3, CloudWatch, X-Ray) | ~$240 |
| **Total production** | **~$2,400** |

### Cost Explorer Query (AWS CLI)

```bash
# Per-service breakdown for the previous calendar month
aws ce get-cost-and-usage \
  --time-period Start=$(date -d "$(date +%Y-%m-01) -1 month" +%Y-%m-01),End=$(date +%Y-%m-01) \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=TAG,Key=Service \
  --filter '{
    "Tags": {
      "Key": "Environment",
      "Values": ["production"],
      "MatchOptions": ["EQUALS"]
    }
  }' \
  --query 'ResultsByTime[0].Groups[*].[Keys[0],Metrics.UnblendedCost.Amount]' \
  --output table
```

---

## Untagged Spend Report

### Purpose

Untagged spend (resources without the `Service` tag) prevents accurate per-service cost
attribution. This view tracks untagged spend and drives it toward zero.

### Cost Explorer Query (Console)

1. Open Cost Explorer → same settings as the per-service report.
2. Set **Group by**: Tag → `Service`.
3. The row labelled **"No tag key: Service"** (or blank/untagged) shows untagged spend.

### Cost Explorer Query (AWS CLI)

```bash
# Untagged spend: resources with no Service tag
aws ce get-cost-and-usage \
  --time-period Start=$(date -d "$(date +%Y-%m-01) -1 month" +%Y-%m-01),End=$(date +%Y-%m-01) \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=TAG,Key=Service \
  --filter '{
    "And": [
      {
        "Tags": {
          "Key": "Environment",
          "Values": ["production"],
          "MatchOptions": ["EQUALS"]
        }
      },
      {
        "Not": {
          "Tags": {
            "Key": "Service",
            "MatchOptions": ["PRESENT"]
          }
        }
      }
    ]
  }' \
  --query 'ResultsByTime[0].Total.UnblendedCost.Amount' \
  --output text
```

### Irreducible Untagged Remainder

Some spend cannot be attributed to the `Service` tag due to AWS limitations:

| Source | Reason | Documented |
|---|---|---|
| ECS-managed Service Connect artefacts | Created by the AWS ECS control plane; not Terraform-managed | [tagging.md — Non-Taggable Resources](tagging.md#non-taggable-resources) |
| AWS-managed resources (e.g., Config rules) | Created by AWS on behalf of the account; tags cannot be applied | Account-level governance |
| Support plan charges | AWS Support is not tagged to a workload | Billing account fixed cost |
| Taxes and credits | Not associated with resource tags | Billing account line items |

The target for the reducible portion (Terraform-managed resources) is **zero**. Any
remaining untagged spend from Terraform-managed resources triggers the `tag:policy-check`
pipeline gate to fail, which prevents the deploy from proceeding.

---

## First-Run Baseline

The first Cost Explorer report run after the five cost allocation tags were activated
in the billing account:

- **Date:** Pending — cost allocation tags must be activated in the billing account
  and take up to 24 hours to propagate. See [tagging.md — Cost Allocation Tag Activation](tagging.md#cost-allocation-tag-activation-manual-step).
- **Expected lag:** The first monthly report may show partial attribution if tags were
  activated mid-month. A complete month of data is required for the baseline to be representative.

Once the first full-month report is available:
1. Run the per-service CLI query above.
2. Capture the output.
3. Commit it to this document under `## First-Run Baseline Output`.

---

## Scheduled Reporting

To automate the monthly report, configure a Cost and Usage Report (CUR) delivered to S3:

1. In the billing account, navigate to **Billing → Cost and Usage Reports → Create report**.
2. Configure:
   - Report name: `travel-platform-monthly`
   - Include resource IDs: Yes
   - Data refresh: Automatic
   - Time granularity: Monthly
   - Delivery S3 bucket: `travel-platform-cur-reports` (create if not exists)
   - Report path prefix: `monthly/`
   - Compression: Parquet (for Athena)
3. After the first CUR is delivered, create an Athena table:

```sql
-- Athena: per-service spend from CUR
SELECT
  line_item_resource_tags['user:Service'] AS service,
  SUM(line_item_unblended_cost)            AS total_cost_usd
FROM "travel_platform_cur"."monthly"
WHERE line_item_resource_tags['user:Environment'] = 'production'
  AND year = '<YYYY>'
  AND month = '<MM>'
GROUP BY line_item_resource_tags['user:Service']
ORDER BY total_cost_usd DESC;
```

```sql
-- Athena: untagged spend (no Service tag)
SELECT
  SUM(line_item_unblended_cost) AS untagged_cost_usd
FROM "travel_platform_cur"."monthly"
WHERE line_item_resource_tags['user:Environment'] = 'production'
  AND (line_item_resource_tags['user:Service'] IS NULL
       OR line_item_resource_tags['user:Service'] = '')
  AND year = '<YYYY>'
  AND month = '<MM>';
```

---

## Cost Allocation Tag Activation Verification

After activating tags in the billing account, verify they appear as Cost Explorer dimensions:

```bash
aws ce list-cost_allocation_tags \
  --type UserDefined \
  --query 'CostAllocationTags[?Status==`Active`].[TagKey,Status]' \
  --output table
```

Expected active tags: `Service`, `Environment`, `CostCentre`, `Owner`, `DataClassification`.

If any tag is missing from the active list, activate it following the procedure in
[tagging.md — Cost Allocation Tag Activation](tagging.md#cost-allocation-tag-activation-manual-step).

---

## Budget Notification Verification

To verify that budget notifications fire and create tickets (AC-6):

1. Open the staging environment's budget in the AWS Budgets console.
2. Temporarily set `total_monthly_limit_usd` in `infra/terraform/envs/staging/budgets.tf`
   to a value below the current month's actual spend (e.g., `1`).
3. Run `terraform plan` and `terraform apply` (after pipeline approval).
4. Within a few minutes, AWS Budgets should send a `100% ACTUAL` notification to the
   `data.aws_sns_topic.alarms` topic.
5. Verify the notification was delivered and a ticket was created by the ticketing integration.
6. Restore the original `total_monthly_limit_usd` value and apply again.

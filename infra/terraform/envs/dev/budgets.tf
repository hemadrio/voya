# dev/budgets.tf — WO-089: Cost allocation budgets
#
# Dev monthly budget set at 10% of the production cost model (~$240).
# Per-line thresholds scaled proportionally from the production model.
# Notifications fire to data.aws_sns_topic.alarms at 80% FORECASTED and 100% ACTUAL.
#
# To verify notification delivery: temporarily lower total_monthly_limit_usd to
# a value below the current month's spend (e.g. 1), confirm a notification is
# delivered to the SNS topic and creates a ticket, then restore the original value.

module "budgets" {
  source = "../../modules/budgets"

  environment                = "dev"
  total_monthly_limit_usd    = 240
  notification_sns_topic_arn = data.aws_sns_topic.alarms.arn
  enable_load_test_budget    = false

  service_line_budgets = {
    fargate = {
      limit_usd = 115
      aws_service_names = [
        "Amazon Elastic Container Service",
        "AWS Fargate",
      ]
    }

    rds = {
      limit_usd = 47
      aws_service_names = [
        "Amazon Relational Database Service",
      ]
    }

    elasticache = {
      limit_usd = 21
      aws_service_names = [
        "Amazon ElastiCache",
      ]
    }

    edge = {
      limit_usd = 19
      aws_service_names = [
        "Amazon CloudFront",
        "AWS WAF",
        "AWS WAFV2",
        "Elastic Load Balancing",
      ]
    }

    nat = {
      limit_usd = 10
      aws_service_names = [
        "Amazon Virtual Private Cloud",
      ]
    }

    other = {
      limit_usd = 24
      aws_service_names = [
        "Amazon Simple Queue Service",
        "Amazon Simple Email Service",
        "Amazon Simple Storage Service",
        "Amazon CloudWatch",
        "AWS X-Ray",
        "AWS Secrets Manager",
        "AWS Systems Manager",
      ]
    }
  }
}

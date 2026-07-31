# production/budgets.tf — WO-089: Cost allocation budgets
#
# Production monthly budget anchored to the documented cost model:
#   Fargate        ~$1,150 / month
#   RDS            ~$  470 / month
#   ElastiCache    ~$  210 / month
#   Edge           ~$  190 / month  (ALB + CloudFront + WAF)
#   NAT            ~$  100 / month
#   Other          ~$  240 / month  (SQS, SES, S3, CloudWatch, X-Ray)
#   Total          ~$2,400 / month
#
# All budgets notify data.aws_sns_topic.alarms at 80% FORECASTED and 100% ACTUAL.
# The load-test budget is separate so Speedscale replay spend does not mask
# production regressions (WO-089 requirement).

module "budgets" {
  source = "../../modules/budgets"

  environment                 = "production"
  total_monthly_limit_usd     = 2400
  notification_sns_topic_arn  = data.aws_sns_topic.alarms.arn
  enable_load_test_budget     = true
  load_test_monthly_limit_usd = 500

  service_line_budgets = {
    fargate = {
      limit_usd = 1150
      aws_service_names = [
        "Amazon Elastic Container Service",
        "AWS Fargate",
      ]
    }

    rds = {
      limit_usd = 470
      aws_service_names = [
        "Amazon Relational Database Service",
      ]
    }

    elasticache = {
      limit_usd = 210
      aws_service_names = [
        "Amazon ElastiCache",
      ]
    }

    edge = {
      limit_usd = 190
      aws_service_names = [
        "Amazon CloudFront",
        "AWS WAF",
        "AWS WAFV2",
        "Elastic Load Balancing",
      ]
    }

    nat = {
      limit_usd = 100
      # NAT Gateway charges are billed under Amazon VPC
      aws_service_names = [
        "Amazon Virtual Private Cloud",
      ]
    }

    other = {
      limit_usd = 240
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

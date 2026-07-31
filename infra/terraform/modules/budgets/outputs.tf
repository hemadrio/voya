output "total_budget_id" {
  description = "Budget ID for the total monthly environment budget."
  value       = aws_budgets_budget.total.id
}

output "total_budget_name" {
  description = "Budget name for the total monthly environment budget."
  value       = aws_budgets_budget.total.name
}

output "service_line_budget_ids" {
  description = "Map of per-cost-line budget IDs keyed by friendly name."
  value       = { for k, v in aws_budgets_budget.service_line : k => v.id }
}

output "service_line_budget_names" {
  description = "Map of per-cost-line budget names keyed by friendly name."
  value       = { for k, v in aws_budgets_budget.service_line : k => v.name }
}

output "load_test_budget_id" {
  description = "Budget ID for the load-test environment budget. Empty string if enable_load_test_budget is false."
  value       = length(aws_budgets_budget.load_test) > 0 ? aws_budgets_budget.load_test[0].id : ""
}

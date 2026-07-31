output "queue_url" {
  description = "URL of the FIFO domain-event queue. Pass as SQS_DOMAIN_EVENTS_QUEUE_URL to the ECS task."
  value       = aws_sqs_queue.domain_events.url
}

output "queue_arn" {
  description = "ARN of the FIFO domain-event queue."
  value       = aws_sqs_queue.domain_events.arn
}

output "dlq_url" {
  description = "URL of the dead-letter queue. Pass as SQS_DLQ_URL to the DLQ consumer task."
  value       = aws_sqs_queue.dlq.url
}

output "dlq_arn" {
  description = "ARN of the dead-letter queue."
  value       = aws_sqs_queue.dlq.arn
}

output "publisher_policy_arn" {
  description = "ARN of the IAM policy granting sqs:SendMessage to publishers. Attach to booking-service and payment-service task roles."
  value       = aws_iam_policy.publisher.arn
}

output "consumer_policy_arn" {
  description = "ARN of the IAM policy granting sqs:ReceiveMessage/DeleteMessage/ChangeMessageVisibility. Attach to notification-service and ai-service task roles."
  value       = aws_iam_policy.consumer.arn
}

output "dlq_consumer_policy_arn" {
  description = "ARN of the IAM policy granting DLQ read access. Attach to the DLQ processor task role."
  value       = aws_iam_policy.dlq_consumer.arn
}

output "queue_depth_alarm_arn" {
  description = "ARN of the CloudWatch alarm for main-queue depth > 100."
  value       = aws_cloudwatch_metric_alarm.queue_depth.arn
}

output "dlq_depth_alarm_arn" {
  description = "ARN of the CloudWatch alarm for DLQ depth >= 1."
  value       = aws_cloudwatch_metric_alarm.dlq_depth.arn
}

# ── Per-domain queue outputs (WO-083) ─────────────────────────────────────────

output "booking_events_queue_url" {
  description = "URL of the booking-events FIFO queue."
  value       = aws_sqs_queue.booking_events.url
}

output "booking_events_queue_arn" {
  description = "ARN of the booking-events FIFO queue."
  value       = aws_sqs_queue.booking_events.arn
}

output "booking_events_dlq_arn" {
  description = "ARN of the booking-events DLQ."
  value       = aws_sqs_queue.booking_events_dlq.arn
}

output "payment_events_queue_url" {
  description = "URL of the payment-events FIFO queue."
  value       = aws_sqs_queue.payment_events.url
}

output "payment_events_queue_arn" {
  description = "ARN of the payment-events FIFO queue."
  value       = aws_sqs_queue.payment_events.arn
}

output "payment_events_dlq_arn" {
  description = "ARN of the payment-events DLQ."
  value       = aws_sqs_queue.payment_events_dlq.arn
}

output "notifications_queue_url" {
  description = "URL of the notifications standard queue."
  value       = aws_sqs_queue.notifications.url
}

output "notifications_queue_arn" {
  description = "ARN of the notifications standard queue."
  value       = aws_sqs_queue.notifications.arn
}

output "notifications_dlq_arn" {
  description = "ARN of the notifications DLQ."
  value       = aws_sqs_queue.notifications_dlq.arn
}

output "notifications_queue_name" {
  description = "Name of the notifications standard queue. Use as consumer_scaling_queue_name for notification-consumer autoscaling."
  value       = aws_sqs_queue.notifications.name
}

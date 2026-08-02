#!/usr/bin/env bash
# LocalStack init — create SQS FIFO queues matching the production topology.
# Executed automatically after LocalStack reaches ready state.
#
# SECURITY: development-only placeholder queue names. No real AWS account IDs.
# Queue URLs use the LocalStack edge port (localhost:4566).

set -euo pipefail

REGION="eu-west-1"
ENDPOINT="http://localhost:4566"
AWS_CMD="awslocal"

echo "[localstack-init] Creating SQS FIFO queues..."

# Notification queue (FIFO + dead-letter)
${AWS_CMD} sqs create-queue \
  --queue-name travel-notification.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true,MessageRetentionPeriod=86400 \
  --region "${REGION}" || echo "[localstack-init] travel-notification.fifo already exists"

${AWS_CMD} sqs create-queue \
  --queue-name travel-notification-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true \
  --region "${REGION}" || echo "[localstack-init] travel-notification-dlq.fifo already exists"

# Booking queue
${AWS_CMD} sqs create-queue \
  --queue-name travel-booking.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true,MessageRetentionPeriod=86400 \
  --region "${REGION}" || echo "[localstack-init] travel-booking.fifo already exists"

${AWS_CMD} sqs create-queue \
  --queue-name travel-booking-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true \
  --region "${REGION}" || echo "[localstack-init] travel-booking-dlq.fifo already exists"

# Payment queue
${AWS_CMD} sqs create-queue \
  --queue-name travel-payment.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true,MessageRetentionPeriod=86400 \
  --region "${REGION}" || echo "[localstack-init] travel-payment.fifo already exists"

${AWS_CMD} sqs create-queue \
  --queue-name travel-payment-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true \
  --region "${REGION}" || echo "[localstack-init] travel-payment-dlq.fifo already exists"

# Domain-events queue (WO-051) — @travel/queue SqsAdapter target.
# ContentBasedDeduplication=false: producers supply explicit MessageDeduplicationId
# (the domain event UUID) matching the production FIFO queue configuration.
${AWS_CMD} sqs create-queue \
  --queue-name travel-domain-events-dlq.fifo \
  --attributes "FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600" \
  --region "${REGION}" || echo "[localstack-init] travel-domain-events-dlq.fifo already exists"

DLQ_ARN=$(${AWS_CMD} sqs get-queue-attributes \
  --queue-url "http://localhost:4566/000000000000/travel-domain-events-dlq.fifo" \
  --attribute-names QueueArn \
  --region "${REGION}" \
  --query Attributes.QueueArn \
  --output text)

${AWS_CMD} sqs create-queue \
  --queue-name travel-domain-events.fifo \
  --attributes "FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=345600,VisibilityTimeout=300,ReceiveMessageWaitTimeSeconds=20,RedrivePolicy={\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"5\"}" \
  --region "${REGION}" || echo "[localstack-init] travel-domain-events.fifo already exists"

echo "[localstack-init] SQS queues created."
${AWS_CMD} sqs list-queues --region "${REGION}"

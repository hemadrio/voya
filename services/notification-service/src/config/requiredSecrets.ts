import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for notification-service.
 *
 * SES authentication uses the ECS task IAM role — no API keys needed.
 * Operational config (queue URL, from address, configuration set) is
 * injected via task-definition environment variables.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'SQS_QUEUE_URL',
    description:
      'SQS FIFO queue URL for domain event consumption. ' +
      'Injected from the Terraform SQS module output at runtime.',
    minLength: 20,
  },
  {
    envVar: 'SES_FROM_ADDRESS',
    description:
      'Verified SES sender address (e.g. noreply@travel.example.com). ' +
      'Must be a verified identity in SES.',
    minLength: 5,
  },
  {
    envVar: 'REDIS_URL',
    description:
      'Redis connection URL for the idempotency hot-path cache. ' +
      'Format: redis://host:port',
    minLength: 10,
  },
  {
    envVar: 'DATABASE_URL',
    description:
      'PostgreSQL connection string via RDS Proxy (connection_limit=5). ' +
      'Injected from the Terraform RDS Proxy module at runtime.',
    minLength: 20,
  },
];

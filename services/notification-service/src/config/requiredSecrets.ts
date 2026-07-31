import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for notification-service (email consumer).
 *
 * notification-service consumes domain events from SQS and dispatches
 * transactional emails via Amazon SES. SES authentication uses the ECS task
 * role (IAM), not API keys. The consumer does need the queue URL and,
 * in production, a valid SES configuration set name.
 *
 * Note: SQS_QUEUE_URL and SES_FROM_ADDRESS are operational config, not
 * secrets, but they are required for the service to function and are
 * injected via the task definition.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'SQS_QUEUE_URL',
    description:
      'SQS FIFO queue URL for domain event consumption. ' +
      'Injected from the Terraform SQS module output at runtime.',
    minLength: 20,
  },
];

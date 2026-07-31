/**
 * SES email adapter — sends templated transactional emails via Amazon SES v2.
 *
 * Security invariants:
 * - Credentials come from the ECS task IAM role — no explicit key/secret.
 * - Config is injected at construction; no process.env reads inside this file.
 * - Template data is projected explicitly from Zod-validated payload objects;
 *   raw event JSON is never spread into template data.
 * - Secret values (e.g. from address) never appear in log lines.
 */

import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput,
} from '@aws-sdk/client-sesv2';
import {
  SesThrottlingError,
  SesServiceUnavailableError,
  SesPermanentRejectionError,
} from '../domain/backoff.js';

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

export const TEMPLATE_NAMES = {
  BOOKING_CONFIRMATION: 'travel-booking-confirmation-v1',
  CANCELLATION: 'travel-booking-cancellation-v1',
  MODIFICATION: 'travel-booking-modification-v1',
} as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[keyof typeof TEMPLATE_NAMES];

export interface EmailSendRequest {
  readonly toAddress: string;
  readonly templateName: TemplateName;
  readonly templateData: Record<string, string>;
  readonly correlationId: string;
  readonly deduplicationId: string;
}

export interface SesAdapterConfig {
  readonly fromAddress: string;
  readonly configurationSetName?: string | undefined;
  readonly region: string;
}

// ---------------------------------------------------------------------------
// Port interface — injectable for testing
// ---------------------------------------------------------------------------

export interface EmailPort {
  send(request: EmailSendRequest): Promise<void>;
}

// ---------------------------------------------------------------------------
// SesEmailAdapter
// ---------------------------------------------------------------------------

export class SesEmailAdapter implements EmailPort {
  private readonly client: SESv2Client;

  constructor(private readonly config: SesAdapterConfig) {
    this.client = new SESv2Client({ region: config.region });
  }

  async send(request: EmailSendRequest): Promise<void> {
    const input: SendEmailCommandInput = {
      FromEmailAddress: this.config.fromAddress,
      Destination: { ToAddresses: [request.toAddress] },
      Content: {
        Template: {
          TemplateName: request.templateName,
          TemplateData: JSON.stringify(request.templateData),
        },
      },
      ...(this.config.configurationSetName !== undefined
        ? { ConfigurationSetName: this.config.configurationSetName }
        : {}),
    };

    try {
      await this.client.send(new SendEmailCommand(input));
    } catch (err) {
      const name = errorName(err);
      if (name === 'ThrottlingException' || name === 'TooManyRequestsException') {
        throw new SesThrottlingError(`SES throttled: ${name}`);
      }
      if (
        name === 'ServiceUnavailableException' ||
        name === 'InternalFailureException'
      ) {
        throw new SesServiceUnavailableError(`SES unavailable: ${name}`);
      }
      if (
        name === 'MessageRejected' ||
        name === 'AccountSendingPausedException' ||
        name === 'MailFromDomainNotVerifiedException' ||
        name === 'SendingPausedException'
      ) {
        throw new SesPermanentRejectionError(`SES permanently rejected: ${name}`);
      }
      throw err;
    }
  }
}

function errorName(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return String((err as Record<string, unknown>)['name']);
  }
  return undefined;
}

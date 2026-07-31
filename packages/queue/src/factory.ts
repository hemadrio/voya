/**
 * Adapter factory — reads QUEUE_DRIVER and constructs the appropriate adapter.
 *
 * Fails fast (throws) if:
 *   - QUEUE_DRIVER is missing or not one of 'rabbitmq' | 'sqs'
 *   - The required connection secret is missing or matches a known placeholder
 *     value (e.g. 'changeme', 'placeholder', 'undefined', '')
 *
 * This module is intentionally side-effect-free when imported; the factory
 * function validates lazily so tests that never call createQueueAdapter do not
 * trigger startup validation.
 */

import type { QueuePort } from "./QueuePort.js";

// ---------------------------------------------------------------------------
// Known placeholder values that indicate a secret was not properly injected
// ---------------------------------------------------------------------------

const KNOWN_PLACEHOLDERS = new Set([
  "",
  "changeme",
  "placeholder",
  "undefined",
  "null",
  "todo",
  "fixme",
  "<change-me>",
  "your-secret-here",
]);

function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return true;
  return KNOWN_PLACEHOLDERS.has(value.toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// Driver types
// ---------------------------------------------------------------------------

export type QueueDriver = "rabbitmq" | "sqs";

const VALID_DRIVERS: ReadonlySet<string> = new Set(["rabbitmq", "sqs"]);

function assertDriver(raw: string | undefined): QueueDriver {
  if (raw === undefined || !VALID_DRIVERS.has(raw)) {
    throw new Error(
      `Invalid QUEUE_DRIVER: "${raw ?? "<unset>"}". ` +
        `Expected one of: ${[...VALID_DRIVERS].join(", ")}. ` +
        "Set QUEUE_DRIVER in the ECS task environment (injected via Secrets Manager).",
    );
  }
  return raw as QueueDriver;
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface CreateQueueAdapterOptions {
  /**
   * Partial environment override — use in tests to inject QUEUE_DRIVER and
   * secrets without touching process.env.
   */
  env?: Partial<Record<string, string>> | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and return the QueuePort implementation selected by QUEUE_DRIVER.
 *
 * This function performs startup validation and throws on misconfiguration;
 * callers should call it once at service startup and cache the result.
 *
 * Note: actual amqplib connections and SQSClient instances are constructed
 * inside the adapter — the factory creates the adapter with the injected
 * configuration. For testing, call the adapter constructors directly with
 * mocked clients instead of going through the factory.
 */
export async function createQueueAdapter(
  options: CreateQueueAdapterOptions = {},
): Promise<QueuePort> {
  const env = options.env ?? process.env;
  const driver = assertDriver(env["QUEUE_DRIVER"]);

  if (driver === "rabbitmq") {
    const amqpUrl = env["RABBITMQ_URL"];
    if (isPlaceholder(amqpUrl)) {
      throw new Error(
        "RABBITMQ_URL is missing or a known placeholder value. " +
          "Inject the secret via AWS Secrets Manager before starting the service.",
      );
    }

    // Dynamic import so the SQS SDK is not loaded in the RabbitMQ path
    const { default: amqplib } = await import("amqplib");
    const { RabbitMqAdapter } = await import("./adapters/RabbitMqAdapter.js");
    const connection = await amqplib.connect(amqpUrl as string);
    return new RabbitMqAdapter({ connection });
  }

  // driver === 'sqs'
  const sqsEndpoint = env["SQS_ENDPOINT_URL"];
  const awsRegion = env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "us-east-1";

  const { SQSClient } = await import("@aws-sdk/client-sqs");
  const { SqsAdapter } = await import("./adapters/SqsAdapter.js");

  const clientConfig: { region: string; endpoint?: string } = { region: awsRegion };
  if (sqsEndpoint !== undefined && !isPlaceholder(sqsEndpoint)) {
    clientConfig.endpoint = sqsEndpoint;
  }

  const domainEventsQueueUrl = env["SQS_DOMAIN_EVENTS_QUEUE_URL"];
  const dlqUrl = env["SQS_DLQ_URL"];

  if (isPlaceholder(domainEventsQueueUrl)) {
    throw new Error(
      "SQS_DOMAIN_EVENTS_QUEUE_URL is missing or a known placeholder value. " +
        "Inject the secret via AWS Secrets Manager before starting the service.",
    );
  }

  const client = new SQSClient(clientConfig);
  return new SqsAdapter({
    client,
    queueUrls: {
      "domain-events": domainEventsQueueUrl as string,
    },
    dlqUrl: isPlaceholder(dlqUrl) ? undefined : dlqUrl,
  });
}

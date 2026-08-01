import pino from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';
import type { LogContext } from './context.js';

// ---------------------------------------------------------------------------
// PII redact paths — configured once at construction, never at call sites.
//
// Covers: top-level keys, one level deep (*.key), up to four levels deep for
// deeply nested offer/booking snapshots (*.*.*.*.key), array elements ([*].key),
// HTTP header objects (headers.authorization, headers["stripe-signature"]).
// ---------------------------------------------------------------------------
const PII_REDACT_PATHS: ReadonlyArray<string> = [
  // --- email ---
  'email',
  '*.email',
  '*.*.email',
  '*.*.*.email',
  '*.*.*.*.email',
  '[*].email',
  '[*].*.email',
  '[*].*.*.email',
  // --- passwordHash ---
  'passwordHash',
  '*.passwordHash',
  '*.*.passwordHash',
  '*.*.*.passwordHash',
  '*.*.*.*.passwordHash',
  '[*].passwordHash',
  // --- password (plain text, should never be logged) ---
  'password',
  '*.password',
  '*.*.password',
  // --- dateOfBirth ---
  'dateOfBirth',
  '*.dateOfBirth',
  '*.*.dateOfBirth',
  '*.*.*.dateOfBirth',
  '*.*.*.*.dateOfBirth',
  '[*].dateOfBirth',
  '[*].*.dateOfBirth',
  '[*].*.*.dateOfBirth',
  // --- passportNumber ---
  'passportNumber',
  '*.passportNumber',
  '*.*.passportNumber',
  '*.*.*.passportNumber',
  '*.*.*.*.passportNumber',
  '[*].passportNumber',
  '[*].*.passportNumber',
  '[*].*.*.passportNumber',
  // --- HTTP headers ---
  'headers.authorization',
  'headers["stripe-signature"]',
  'headers["Authorization"]',
  'req.headers.authorization',
  'req.headers["stripe-signature"]',
  '*.headers.authorization',
  '*.headers["stripe-signature"]',
  // --- generic secret / key / token fields ---
  // Catches secretKey, apiKey, accessToken, refreshToken, webhookSecret, etc.
  // Top-level and one level deep; deeper nesting is uncommon in log bindings.
  'secret',
  '*.secret',
  'secretKey',
  '*.secretKey',
  'webhookSecret',
  '*.webhookSecret',
  'apiKey',
  '*.apiKey',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'token',
  '*.token',
  'privateKey',
  '*.privateKey',
  'signingKey',
  '*.signingKey',
  // --- Stripe / payment fields (WO-045) ---
  // payment_method is a Stripe object that may contain card data at sub-fields;
  // redact the entire object at top level and one level deep as defence-in-depth.
  'payment_method',
  '*.payment_method',
  // stripe_secret_key and stripe_api_key patterns
  'stripeSecretKey',
  '*.stripeSecretKey',
  'stripeApiKey',
  '*.stripeApiKey',
  // client_secret is the Stripe payment intent secret — redact from logs
  'client_secret',
  '*.client_secret',
  'clientSecret',
  '*.clientSecret',
];

// ---------------------------------------------------------------------------
// String-level PII scrubber for error message / stack fields.
// Pino redact paths cannot reach inside string values, so we run a regex
// pass over error.message and error.stack in the custom serializer.
// ---------------------------------------------------------------------------
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const LONG_DIGIT_RE = /\b\d{7,}\b/g;

function scrubString(value: string): string {
  return value
    .replace(EMAIL_RE, '[REDACTED-EMAIL]')
    .replace(LONG_DIGIT_RE, '[REDACTED-DIGITS]');
}

// ---------------------------------------------------------------------------
// Custom error serializer — wraps pino.stdSerializers.err and runs scrubString
// over message and stack before emission.
// ---------------------------------------------------------------------------
type SerializedErrorShape = {
  type?: string | undefined;
  message?: string | undefined;
  stack?: string | undefined;
};

function buildErrorSerializer(): (err: unknown) => SerializedErrorShape {
  return (err: unknown): SerializedErrorShape => {
    try {
      const raw = pino.stdSerializers.err(err) as SerializedErrorShape;
      const result: SerializedErrorShape = {
        type: raw.type,
        message: typeof raw.message === 'string' ? scrubString(raw.message) : raw.message,
      };
      if (typeof raw.stack === 'string') {
        result.stack = scrubString(raw.stack);
      }
      return result;
    } catch {
      const name =
        err !== null &&
        typeof err === 'object' &&
        'name' in err &&
        typeof (err as { name: unknown }).name === 'string'
          ? (err as { name: string }).name
          : 'Error';
      return { type: name, message: 'Error serialization failed' };
    }
  };
}

// ---------------------------------------------------------------------------
// LOG_LEVEL resolution
// ---------------------------------------------------------------------------
const VALID_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
type ValidLevel = (typeof VALID_LEVELS)[number];

function resolveLogLevel(): ValidLevel {
  const raw = process.env['LOG_LEVEL'];
  if (raw === undefined || raw === '') return 'info';
  if (!(VALID_LEVELS as ReadonlyArray<string>).includes(raw)) {
    throw new Error(
      `Invalid LOG_LEVEL: "${raw}". Must be one of: ${VALID_LEVELS.join(', ')}.`
    );
  }
  const level = raw as ValidLevel;
  // debug is only allowed outside production — silently promote rather than throw
  // so a misconfigured production deployment degrades gracefully.
  if (level === 'debug' && process.env['NODE_ENV'] === 'production') {
    return 'info';
  }
  return level;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface CreateLoggerOptions {
  readonly service: string;
  /** Optional image tag or semver from IMAGE_TAG env var. */
  readonly version?: string;
}

/**
 * Factory that returns a Pino logger with:
 * - Single-line JSON output (CloudWatch Logs Insights compatible)
 * - ISO 8601 timestamps
 * - Base bindings: service, env, version (if provided)
 * - LOG_LEVEL driven from env (validated at construction)
 * - PII redaction configured once — cannot be forgotten at call sites
 * - Custom error serializer scrubbing email/digit patterns from stacks
 * - pino-pretty transport only in NODE_ENV=development (never in production)
 *
 * Pass a destination stream to capture output in tests or redirect logs.
 * Without a destination, logs go to process.stdout via pino defaults.
 */
export function createLogger(options: CreateLoggerOptions, destination?: DestinationStream): Logger {
  if (options.service.trim() === '') {
    throw new Error(
      'createLogger: "service" option is required and must not be empty. ' +
        'Provide the service name (e.g. "booking-service").'
    );
  }

  const level = resolveLogLevel();
  const isDev = process.env['NODE_ENV'] === 'development';

  const baseBindings: Record<string, string> = {
    service: options.service,
    env: process.env['NODE_ENV'] ?? 'unknown',
  };
  if (options.version !== undefined) {
    baseBindings['version'] = options.version;
  }

  const pinoOpts: LoggerOptions = {
    level,
    base: baseBindings,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: PII_REDACT_PATHS as string[],
      censor: '[REDACTED]',
      remove: false,
    },
    serializers: {
      err: buildErrorSerializer(),
    },
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  };

  // Pretty transport only in development and only when no custom destination
  // is provided (transport and destination are mutually exclusive in pino).
  if (isDev && destination === undefined) {
    pinoOpts.transport = { target: 'pino-pretty' };
  }

  const logger =
    destination !== undefined ? pino(pinoOpts, destination) : pino(pinoOpts);

  // Forward destination stream errors to stderr so transport failures do not
  // silently swallow logs or throw into business code paths.
  if (destination !== undefined && typeof (destination as Record<string, unknown>)['on'] === 'function') {
    const emitter = destination as unknown as NodeJS.EventEmitter;
    emitter.on('error', (err: Error) => {
      process.stderr.write(
        `[observability] destination stream error: ${err.message}\n`
      );
    });
  }

  return logger;
}

/**
 * Creates a child logger that inherits redaction settings from `parent` and
 * merges the supplied typed LogContext bindings. Only defined (non-undefined)
 * fields are added to the child's bindings.
 *
 * Accepts only typed LogContext keys — callers cannot inject arbitrary fields
 * here, satisfying the Type Safety policy's ban on index signatures in
 * structured logging context.
 */
export function createChildLogger(parent: Logger, context: LogContext): Logger {
  const bindings: Record<string, string> = {};
  if (context.correlationId !== undefined) bindings['correlationId'] = context.correlationId;
  if (context.traceId !== undefined) bindings['traceId'] = context.traceId;
  if (context.userId !== undefined) bindings['userId'] = context.userId;
  if (context.operation !== undefined) bindings['operation'] = context.operation;
  if (context.resource !== undefined) bindings['resource'] = context.resource;
  if (context.supplierName !== undefined) bindings['supplierName'] = context.supplierName;
  if (context.bookingId !== undefined) bindings['bookingId'] = context.bookingId;
  return parent.child(bindings);
}

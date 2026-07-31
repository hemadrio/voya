import type { ZodIssue } from "zod";

/**
 * Thrown by QueuePort.publish() when the envelope fails QueueMessageEnvelopeSchema
 * Zod parse. The caller (booking-service saga, payment-service event publisher)
 * should treat this as a programming error — an invalid envelope means the
 * producer has a bug, not a transient infrastructure problem, so no retry
 * should be attempted.
 */
export class QueueValidationError extends Error {
  /** The Zod issues that caused the parse failure. */
  readonly issues: ReadonlyArray<ZodIssue>;

  constructor(message: string, issues: ReadonlyArray<ZodIssue>) {
    super(message);
    this.name = "QueueValidationError";
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isQueueValidationError(err: unknown): err is QueueValidationError {
  return err instanceof QueueValidationError;
}

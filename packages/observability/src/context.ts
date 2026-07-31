/**
 * Typed context bound to a child logger.
 *
 * No index signature — satisfies the Type Safety policy which bans arbitrary
 * key additions after construction. Callers that need to log ad-hoc fields
 * must use the parent logger's object argument (`logger.info({ extra }, msg)`)
 * rather than adding keys to LogContext.
 */
export interface LogContext {
  readonly correlationId?: string;
  readonly traceId?: string;
  readonly userId?: string;
  readonly operation?: string;
  readonly resource?: string;
  readonly supplierName?: string;
  readonly bookingId?: string;
}

/**
 * Interfaces for the illustrative offer generation subsystem.
 *
 * All concrete implementations are injected at construction time;
 * the generator itself never reads process.env or constructs I/O clients.
 */

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/** The flag key checked before any illustrative offer is produced. */
export const ILLUSTRATIVE_FLAG_KEY = 'illustrative-offers-enabled';

/**
 * Injectable feature flag provider.
 * Errors thrown by isEnabled() are treated as flag = disabled (fail safe).
 */
export interface FeatureFlagProvider {
  isEnabled(flagKey: string, environment: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Audit writer
// ---------------------------------------------------------------------------

/** Describes which event is being audited. */
export type AuditRecordType = 'ILLUSTRATIVE_OFFERS_SERVED';

/**
 * The state of the feature flag at the time the record was written.
 * Recorded to provide a complete picture of why illustrative offers appeared.
 */
export type FlagState = 'enabled' | 'flag_disabled' | 'hard_disabled';

/**
 * Immutable audit record written every time illustrative offers are served
 * in a production (or any audited) environment.
 *
 * The AuditWriter interface exposes only append operations; no update or
 * delete path exists, satisfying the append-only constraint in the spec.
 */
export interface AuditRecord {
  readonly type: AuditRecordType;
  /** System actor identifier — never a human user credential. */
  readonly actor: string;
  readonly timestamp: Date;
  readonly environment: string;
  /** Travel vertical: 'flight' | 'hotel' | 'car'. */
  readonly category: string;
  readonly flagState: FlagState;
  readonly correlationId: string;
  /** Number of illustrative offers included in the response. */
  readonly offersCount: number;
}

/**
 * Append-only audit writer.
 * Implementations must not expose update() or delete() methods.
 * A failed write() must throw so the generator can fail closed.
 */
export interface AuditWriter {
  write(record: AuditRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Generator config
// ---------------------------------------------------------------------------

export interface IllustrativeGeneratorConfig {
  /**
   * The current deployment environment (e.g. 'production', 'staging', 'dev').
   * Evaluated against hardDisabledEnvironments at every call.
   */
  readonly environment: string;

  /**
   * Environments for which illustrative offers are NEVER produced, regardless
   * of flag state.  Typically: ['production'] when sponsor Q2 is unresolved.
   * Evaluated before the flag check — cannot be overridden by the flag.
   */
  readonly hardDisabledEnvironments: ReadonlyArray<string>;

  /**
   * System actor string included in every audit record.
   * Must not contain credentials or personal identifiers.
   */
  readonly actorIdentifier: string;

  /**
   * Number of minutes until illustrative offers expire.
   * Default: 30 minutes.
   */
  readonly defaultValidityMinutes: number;
}

// ---------------------------------------------------------------------------
// Minimal logger
// ---------------------------------------------------------------------------

export interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

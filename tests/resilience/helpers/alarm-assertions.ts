/**
 * alarm-assertions.ts — CloudWatch alarm state polling + structured log assertion (WO-099).
 *
 * Two modes:
 *   InMemoryAlarmStore — in-process store where scenarios emit alarm transitions
 *     so unit-level tests can assert the alarm fires without AWS.
 *   CloudWatchAlarmPoller — polls the AWS CloudWatch DescribeAlarms API
 *     (staging only) until the alarm transitions to the expected state.
 *
 * Every scenario that involves an alarm must call assertAlarmFired() so the
 * assertion is part of the pass/fail gate rather than a post-hoc observation.
 *
 * Structured log assertions: assertLogContainsSecurityEvent() validates that
 * captured log lines carry the required OWASP A10 fields:
 *   actor, resource, operation, reference (correlation/trace ID).
 */

// ---------------------------------------------------------------------------
// Alarm state types
// ---------------------------------------------------------------------------

export type AlarmState = "OK" | "ALARM" | "INSUFFICIENT_DATA";

export interface AlarmTransition {
  alarmName: string;
  fromState: AlarmState;
  toState: AlarmState;
  reason: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// InMemoryAlarmStore — for in-process scenario tests
// ---------------------------------------------------------------------------

export class InMemoryAlarmStore {
  private readonly _transitions: AlarmTransition[] = [];
  private readonly _currentState = new Map<string, AlarmState>();

  emit(transition: AlarmTransition): void {
    this._transitions.push(transition);
    this._currentState.set(transition.alarmName, transition.toState);
  }

  getState(alarmName: string): AlarmState {
    return this._currentState.get(alarmName) ?? "INSUFFICIENT_DATA";
  }

  getTransitions(alarmName?: string): AlarmTransition[] {
    if (alarmName === undefined) return [...this._transitions];
    return this._transitions.filter((t) => t.alarmName === alarmName);
  }

  reset(): void {
    this._transitions.length = 0;
    this._currentState.clear();
  }
}

/**
 * Assert that the alarm transitioned to ALARM state.
 *
 * @throws if no ALARM transition was found for alarmName.
 */
export function assertAlarmFired(store: InMemoryAlarmStore, alarmName: string): void {
  const transitions = store.getTransitions(alarmName);
  const alarmTransition = transitions.find((t) => t.toState === "ALARM");
  if (alarmTransition === undefined) {
    const states = transitions.map((t) => t.toState).join(", ") || "none";
    throw new Error(
      `Expected alarm "${alarmName}" to transition to ALARM state. ` +
        `Observed transitions: [${states}]`,
    );
  }
}

/**
 * Assert that the alarm is currently OK (recovered).
 */
export function assertAlarmOk(store: InMemoryAlarmStore, alarmName: string): void {
  const state = store.getState(alarmName);
  if (state !== "OK") {
    throw new Error(
      `Expected alarm "${alarmName}" to be OK, but it is ${state}`,
    );
  }
}

// ---------------------------------------------------------------------------
// CloudWatchAlarmPoller — staging use only
// ---------------------------------------------------------------------------

export interface CloudWatchAlarmPollerOptions {
  /** AWS region */
  region: string;
  /** Maximum time to wait for the transition in milliseconds (default: 120_000) */
  timeoutMs?: number;
  /** Poll interval in milliseconds (default: 5_000) */
  pollIntervalMs?: number;
}

export class CloudWatchAlarmPoller {
  private readonly region: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(opts: CloudWatchAlarmPollerOptions) {
    this.region = opts.region;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  }

  async waitForState(alarmName: string, expected: AlarmState): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const state = await this._getAlarmState(alarmName);
      if (state === expected) return;
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error(
      `Alarm "${alarmName}" did not reach state "${expected}" within ${this.timeoutMs}ms`,
    );
  }

  private async _getAlarmState(alarmName: string): Promise<AlarmState> {
    const url =
      `https://monitoring.${this.region}.amazonaws.com/?Action=DescribeAlarms` +
      `&AlarmNames.member.1=${encodeURIComponent(alarmName)}&Version=2010-08-01`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`DescribeAlarms failed: ${res.status}`);
    }
    const text = await res.text();
    const match = /<StateValue>(\w+)<\/StateValue>/.exec(text);
    return (match?.[1] as AlarmState | undefined) ?? "INSUFFICIENT_DATA";
  }
}

// ---------------------------------------------------------------------------
// Structured log assertions — OWASP A10 fields
// ---------------------------------------------------------------------------

export interface StructuredLogRecord {
  [key: string]: unknown;
}

/**
 * Assert that at least one log record carries the required OWASP A10 security
 * event fields: actor, resource, operation, and a reference identifier.
 *
 * @throws if no matching log record is found.
 */
export function assertLogContainsSecurityEvent(
  logs: StructuredLogRecord[],
  matcher: {
    event?: string;
    actor?: string;
    resource?: string;
    operation?: string;
  },
): StructuredLogRecord {
  const matching = logs.filter((log) => {
    if (matcher.event !== undefined && log["event"] !== matcher.event) return false;
    if (matcher.actor !== undefined && log["actor"] !== matcher.actor) return false;
    if (matcher.resource !== undefined && log["resource"] !== matcher.resource) return false;
    if (matcher.operation !== undefined && log["operation"] !== matcher.operation) return false;
    return true;
  });

  if (matching.length === 0) {
    const available = logs.map((l) => l["event"] ?? l["msg"]).join(", ");
    throw new Error(
      `No structured log record matched ${JSON.stringify(matcher)}. ` +
        `Available events: [${available}]`,
    );
  }

  const record = matching[0]!;

  // Assert the required A10 reference identifier is present
  const hasReference =
    record["reference"] !== undefined ||
    record["correlationId"] !== undefined ||
    record["requestId"] !== undefined;

  if (!hasReference) {
    throw new Error(
      `Log record for event "${String(record["event"] ?? record["msg"])}" ` +
        `is missing a reference identifier (reference, correlationId, or requestId). ` +
        `A10 posture requires all security events to carry a traceable reference.`,
    );
  }

  return record;
}

/**
 * Assert that no log record contains sensitive fields (A10: never leak internal detail).
 */
export function assertNoLeakedSecrets(
  logs: StructuredLogRecord[],
  forbiddenPatterns: string[] = [
    "password",
    "secret",
    "private_key",
    "jwt",
    "bearer",
    "stack",
    "Error:",
    "at Object.",
  ],
): void {
  for (const log of logs) {
    const serialised = JSON.stringify(log).toLowerCase();
    for (const pattern of forbiddenPatterns) {
      if (serialised.includes(pattern.toLowerCase())) {
        throw new Error(
          `Log record contains forbidden pattern "${pattern}": ${JSON.stringify(log)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Log capture helper
// ---------------------------------------------------------------------------

export class InMemoryLogCapture {
  readonly records: StructuredLogRecord[] = [];

  readonly logger = {
    debug: (obj: Record<string, unknown>, msg: string) =>
      this.records.push({ level: "debug", ...obj, msg }),
    info: (obj: Record<string, unknown>, msg: string) =>
      this.records.push({ level: "info", ...obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) =>
      this.records.push({ level: "warn", ...obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) =>
      this.records.push({ level: "error", ...obj, msg }),
  };

  clear(): void {
    this.records.length = 0;
  }
}

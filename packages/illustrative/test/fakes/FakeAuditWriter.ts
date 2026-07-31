import type { AuditWriter, AuditRecord } from '../../src/types.js';

/**
 * In-memory audit writer for tests.
 *
 * Captures all written records for assertion.  Optionally configured to
 * throw to test the fail-closed behaviour (audit failure → suppress offers).
 *
 * Append-only: no update() or delete() method is exposed, matching the
 * production contract.
 */
export class FakeAuditWriter implements AuditWriter {
  readonly records: AuditRecord[] = [];
  private shouldThrow: boolean;

  constructor() {
    this.shouldThrow = false;
  }

  /** Configure this fake to throw on the next write() call. */
  failNext(): void {
    this.shouldThrow = true;
  }

  async write(record: AuditRecord): Promise<void> {
    if (this.shouldThrow) {
      this.shouldThrow = false;
      throw new Error('FakeAuditWriter: simulated audit write failure');
    }
    // Immutable push — records are never modified after being written
    this.records.push(Object.freeze({ ...record }));
  }

  /** Reset captured records (between test cases). */
  reset(): void {
    this.records.length = 0;
  }
}

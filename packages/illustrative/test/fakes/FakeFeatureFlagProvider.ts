import type { FeatureFlagProvider } from '../../src/types.js';

/**
 * In-memory feature flag provider for tests.
 *
 * Flags are configured at construction time via a simple map.
 * Optionally configured to throw on the next call to simulate flag
 * provider outages (error path: treat as disabled).
 */
export class FakeFeatureFlagProvider implements FeatureFlagProvider {
  private readonly flags: Map<string, boolean>;
  private shouldThrow: boolean;

  constructor(flags: Record<string, boolean> = {}) {
    this.flags = new Map(Object.entries(flags));
    this.shouldThrow = false;
  }

  /** Configure this fake to throw on the next isEnabled() call. */
  failNext(): void {
    this.shouldThrow = true;
  }

  /** Set a flag value. */
  setFlag(flagKey: string, value: boolean): void {
    this.flags.set(flagKey, value);
  }

  async isEnabled(flagKey: string, _environment: string): Promise<boolean> {
    if (this.shouldThrow) {
      this.shouldThrow = false;
      throw new Error('FakeFeatureFlagProvider: simulated flag provider outage');
    }
    return this.flags.get(flagKey) ?? false;
  }
}

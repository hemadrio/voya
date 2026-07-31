/**
 * Unit tests for the pure gating decision function.
 *
 * Exhaustive matrix: hardDisabled × flagEnabled × supplierUnavailable.
 * Covers all 8 input combinations — only the last row should return 'allow'.
 */

import { evaluateGating } from '../../src/gating.js';
import type { GatingInput } from '../../src/gating.js';

const PROD = 'production';
const STAGING = 'staging';
const HARD_DISABLED: ReadonlyArray<string> = [PROD];

function input(overrides: Partial<GatingInput>): GatingInput {
  return {
    environment: STAGING,
    hardDisabledEnvironments: HARD_DISABLED,
    flagEnabled: true,
    supplierWasUnavailable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Hard-disable takes priority over everything
// ---------------------------------------------------------------------------

describe('evaluateGating — hard-disabled environment', () => {
  it('suppresses when environment is hard-disabled (flag enabled, supplier unavailable)', () => {
    const result = evaluateGating(
      input({ environment: PROD, flagEnabled: true, supplierWasUnavailable: true }),
    );
    expect(result.decision).toBe('suppress');
    expect(result.reason).toBe('hard_disabled');
  });

  it('suppresses when environment is hard-disabled (flag disabled)', () => {
    const result = evaluateGating(
      input({ environment: PROD, flagEnabled: false, supplierWasUnavailable: true }),
    );
    expect(result.decision).toBe('suppress');
    expect(result.reason).toBe('hard_disabled');
  });

  it('suppresses when environment is hard-disabled (supplier available)', () => {
    const result = evaluateGating(
      input({ environment: PROD, flagEnabled: true, supplierWasUnavailable: false }),
    );
    expect(result.decision).toBe('suppress');
    expect(result.reason).toBe('hard_disabled');
  });

  it('suppresses for any environment in the hard-disable list', () => {
    const result = evaluateGating(
      input({
        environment: 'dr-test',
        hardDisabledEnvironments: [PROD, 'dr-test'],
        flagEnabled: true,
        supplierWasUnavailable: true,
      }),
    );
    expect(result.decision).toBe('suppress');
    expect(result.reason).toBe('hard_disabled');
  });

  it('allows when environment is NOT in the hard-disable list', () => {
    const result = evaluateGating(
      input({
        environment: STAGING,
        hardDisabledEnvironments: [PROD],
        flagEnabled: true,
        supplierWasUnavailable: true,
      }),
    );
    expect(result.decision).toBe('allow');
  });

  it('allows when hard-disable list is empty', () => {
    const result = evaluateGating(
      input({
        hardDisabledEnvironments: [],
        flagEnabled: true,
        supplierWasUnavailable: true,
      }),
    );
    expect(result.decision).toBe('allow');
  });

  it('zero offers are produced in production (hard-disable guarantee)', () => {
    const result = evaluateGating(
      input({ environment: PROD, hardDisabledEnvironments: [PROD] }),
    );
    expect(result.decision).toBe('suppress');
    expect(result.reason).toBe('hard_disabled');
  });
});

// ---------------------------------------------------------------------------
// Flag disabled — not hard-disabled environment
// ---------------------------------------------------------------------------

describe('evaluateGating — flag disabled', () => {
  it('suppresses when flag is disabled, supplier unavailable', () => {
    const result = evaluateGating(
      input({ flagEnabled: false, supplierWasUnavailable: true }),
    );
    expect(result.decision).toBe('suppress');
    expect(result.reason).toBe('flag_disabled');
  });

  it('suppresses when flag is disabled, supplier available', () => {
    const result = evaluateGating(
      input({ flagEnabled: false, supplierWasUnavailable: false }),
    );
    expect(result.decision).toBe('suppress');
    expect(result.reason).toBe('flag_disabled');
  });
});

// ---------------------------------------------------------------------------
// Suppliers available — not hard-disabled, flag enabled
// ---------------------------------------------------------------------------

describe('evaluateGating — suppliers available', () => {
  it('suppresses when flag is enabled but no supplier was unavailable', () => {
    const result = evaluateGating(
      input({ flagEnabled: true, supplierWasUnavailable: false }),
    );
    expect(result.decision).toBe('suppress');
    expect(result.reason).toBe('suppliers_available');
  });
});

// ---------------------------------------------------------------------------
// The single allow condition
// ---------------------------------------------------------------------------

describe('evaluateGating — allow', () => {
  it('allows when not hard-disabled AND flag enabled AND supplier was unavailable', () => {
    const result = evaluateGating(
      input({ flagEnabled: true, supplierWasUnavailable: true }),
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('flag_enabled_and_supplier_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Exhaustive matrix (all 8 combinations with hard-disabled = production)
// ---------------------------------------------------------------------------

describe('evaluateGating — exhaustive matrix', () => {
  const cases: Array<[boolean, boolean, boolean, string]> = [
    // hardDisabled, flagEnabled, supplierUnavailable, expectedDecision
    [true, true, true, 'suppress'],
    [true, true, false, 'suppress'],
    [true, false, true, 'suppress'],
    [true, false, false, 'suppress'],
    [false, false, true, 'suppress'],
    [false, false, false, 'suppress'],
    [false, true, false, 'suppress'],
    [false, true, true, 'allow'], // ← the only allow combination
  ];

  it.each(cases)(
    'hardDisabled=%s, flagEnabled=%s, supplierUnavailable=%s → %s',
    (hardDisabled, flagEnabled, supplierUnavailable, expectedDecision) => {
      const result = evaluateGating({
        environment: hardDisabled ? PROD : STAGING,
        hardDisabledEnvironments: [PROD],
        flagEnabled,
        supplierWasUnavailable: supplierUnavailable,
      });
      expect(result.decision).toBe(expectedDecision);
    },
  );
});

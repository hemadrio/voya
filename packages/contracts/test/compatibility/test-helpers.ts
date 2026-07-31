/**
 * Thin assertion helper layer.
 *
 * All contract-compatibility tests import their assertion primitives from
 * this module rather than from vitest directly.  If the project switches from
 * vitest to Jest 29 (see README — unratified assumption TA-001), only this
 * file needs updating; no test assertions need rewriting.
 *
 * Ratification owner: tech lead (@contracts-steward)
 */
export { describe, it, expect, beforeAll } from "vitest";

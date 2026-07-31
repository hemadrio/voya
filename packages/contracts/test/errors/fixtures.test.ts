import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "../../src/errors/envelope.js";
import { ALLOWED_HTTP_STATUSES } from "../../src/errors/codes.js";

import error400 from "../fixtures/errors/400-validation-failed.json" with { type: "json" };
import error401 from "../fixtures/errors/401-unauthenticated.json" with { type: "json" };
import error403 from "../fixtures/errors/403-forbidden.json" with { type: "json" };
import error404 from "../fixtures/errors/404-not-found.json" with { type: "json" };
import error409 from "../fixtures/errors/409-lifecycle-conflict.json" with { type: "json" };
import error422 from "../fixtures/errors/422-supplier-rejected.json" with { type: "json" };
import error429 from "../fixtures/errors/429-rate-limited.json" with { type: "json" };
import error500 from "../fixtures/errors/500-internal-error.json" with { type: "json" };
import error502 from "../fixtures/errors/502-supplier-unavailable.json" with { type: "json" };
import error504 from "../fixtures/errors/504-supplier-timeout.json" with { type: "json" };

/**
 * AC11 — every committed error fixture must parse against ErrorEnvelopeSchema,
 * covering one representative envelope per allowed HTTP status.
 */
describe("committed error fixtures parse against ErrorEnvelopeSchema", () => {
  const cases: Array<[number, unknown]> = [
    [400, error400],
    [401, error401],
    [403, error403],
    [404, error404],
    [409, error409],
    [422, error422],
    [429, error429],
    [500, error500],
    [502, error502],
    [504, error504],
  ];

  it.each(cases)("HTTP %d fixture parses successfully", (_status, fixture) => {
    const result = ErrorEnvelopeSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it("covers all allowed HTTP statuses", () => {
    const coveredStatuses = new Set(cases.map(([s]) => s));
    for (const allowed of ALLOWED_HTTP_STATUSES) {
      expect(coveredStatuses.has(allowed), `Missing fixture for HTTP ${allowed}`).toBe(true);
    }
  });
});

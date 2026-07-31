import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import { apiGet, apiPost } from "../api-client.js";
import { ErrorEnvelopeSchema } from "@travel/contracts/errors";

// ---------------------------------------------------------------------------
// Test schema (simple, not a real contracts schema)
// ---------------------------------------------------------------------------

const UserSchema = z.object({ id: z.string(), name: z.string() }).strict();
type User = z.infer<typeof UserSchema>;

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown) {
  const jsonBody = body === null ? Promise.reject(new SyntaxError("Not JSON")) : Promise.resolve(body);
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    url: "https://api.travel.internal/v1/test",
    json: () => jsonBody,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("apiGet — success path", () => {
  it("returns ok: true with data when response parses against schema", async () => {
    const body: User = { id: "u1", name: "Maya" };
    vi.stubGlobal("fetch", mockFetch(200, body));

    const result = await apiGet("/test", UserSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("u1");
      expect(result.data.name).toBe("Maya");
      expect(result.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Error envelope path
// ---------------------------------------------------------------------------

describe("apiGet — error envelope path", () => {
  it("returns ok: false with error envelope on 400", async () => {
    const envelope = {
      error: {
        code: "VALIDATION_FAILED",
        message: "Airport code must be a valid 3-letter IATA code",
        field: "origin",
      },
      reference: "ref-400-test",
    };
    vi.stubGlobal("fetch", mockFetch(400, envelope));

    const result = await apiGet("/test", UserSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.error.field).toBe("origin");
      expect(result.error.reference).toBe("ref-400-test");
      // The returned error must conform to the contracts envelope schema
      expect(ErrorEnvelopeSchema.safeParse(result.error).success).toBe(true);
    }
  });

  it("returns ok: false with 401 envelope on unauthenticated", async () => {
    const envelope = {
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
      reference: "ref-401-test",
    };
    vi.stubGlobal("fetch", mockFetch(401, envelope));

    const result = await apiGet("/test", UserSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error.error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("returns ok: false with 403 envelope on forbidden", async () => {
    const envelope = {
      error: { code: "FORBIDDEN", message: "Access denied" },
      reference: "ref-403-test",
    };
    vi.stubGlobal("fetch", mockFetch(403, envelope));

    const result = await apiGet("/test", UserSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error.error.code).toBe("FORBIDDEN");
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed / non-JSON error body
// ---------------------------------------------------------------------------

describe("apiGet — malformed error body", () => {
  it("synthesises a valid envelope when error body is not JSON", async () => {
    vi.stubGlobal("fetch", mockFetch(500, null)); // null → JSON parse fails

    const result = await apiGet("/test", UserSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      // Synthesised envelope must still be valid
      expect(ErrorEnvelopeSchema.safeParse(result.error).success).toBe(true);
      // Must contain a non-empty reference
      expect(result.error.reference.length).toBeGreaterThan(0);
      // Must use INTERNAL_ERROR code
      expect(result.error.error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("synthesises a valid envelope when error body is an HTML page", async () => {
    const htmlBody = "<html><body>Bad Gateway</body></html>";
    // Simulate a gateway returning HTML — JSON.parse fails
    vi.stubGlobal("fetch", {
      ...mockFetch(502, {}),
      mockResolvedValue: undefined,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      url: "https://api.travel.internal/v1/test",
      json: () => Promise.reject(new SyntaxError("Not JSON")),
    }));

    const result = await apiGet("/test", UserSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(ErrorEnvelopeSchema.safeParse(result.error).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// apiPost
// ---------------------------------------------------------------------------

describe("apiPost", () => {
  it("sends POST with JSON body and parses successful response", async () => {
    const responseBody: User = { id: "u2", name: "Devan" };
    const captureFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      url: "https://api.travel.internal/v1/users",
      json: () => Promise.resolve(responseBody),
    });
    vi.stubGlobal("fetch", captureFetch);

    const result = await apiPost("/users", { email: "devan@example.com" }, UserSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("u2");
    }

    const [url, options] = captureFetch.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(options.body as string)).toEqual({ email: "devan@example.com" });
  });

  it("returns ok: false with envelope on 409 conflict from POST", async () => {
    const envelope = {
      error: { code: "LIFECYCLE_CONFLICT", message: "Booking is already CONFIRMED" },
      reference: "ref-409-test",
    };
    vi.stubGlobal("fetch", mockFetch(409, envelope));

    const result = await apiPost("/bookings", {}, UserSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error.error.code).toBe("LIFECYCLE_CONFLICT");
    }
  });
});

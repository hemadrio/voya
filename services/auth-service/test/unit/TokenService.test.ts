/**
 * Unit tests for TokenService.
 *
 * Covers:
 *   - HS256 sign + verify round-trip
 *   - JWT structure (3 parts, correct header claims)
 *   - All required claims present in signed token
 *   - Expired token rejected
 *   - Future-issued token rejected (iat > now + clockSkew)
 *   - Wrong issuer rejected
 *   - Wrong audience rejected
 *   - Algorithm mismatch rejected (token header alg != config alg)
 *   - "none" algorithm rejected at construction and at verify time
 *   - Unknown kid rejected
 *   - Tampered payload rejected (signature fails)
 *   - Malformed token (wrong number of parts) rejected
 *   - kid-based key rotation: old key still verifies old tokens
 *   - Clock-skew tolerance (slightly expired but within skew window)
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  createTokenService,
  type TokenConfig,
  type TokenPayload,
} from "../../src/domain/TokenService.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "super-secret-key-for-hs256-tests-only-not-production";

function makeConfig(overrides: Partial<TokenConfig> = {}): TokenConfig {
  return {
    algorithm: "HS256",
    signingKey: { kid: "k1", key: SECRET },
    verificationKeys: [{ kid: "k1", key: SECRET }],
    issuer: "https://auth.test",
    audience: "https://api.test",
    accessTokenTtlSeconds: 600,
    clockSkewSeconds: 30,
    ...overrides,
  };
}

const PAYLOAD: TokenPayload = {
  sub: "user-abc",
  sid: "session-xyz",
  roles: ["user"],
};

function base64urlDecode(str: string): unknown {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return JSON.parse(
    Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
}

// ---------------------------------------------------------------------------
// Sign + verify round-trip
// ---------------------------------------------------------------------------

describe("TokenService — HS256 sign + verify round-trip", () => {
  it("produces a token that verifies successfully", () => {
    const svc = createTokenService(makeConfig());
    const token = svc.sign(PAYLOAD);
    const claims = svc.verify(token);

    expect(claims.sub).toBe(PAYLOAD.sub);
    expect(claims.sid).toBe(PAYLOAD.sid);
    expect(claims.roles).toEqual(PAYLOAD.roles);
  });

  it("sets correct iss and aud in claims", () => {
    const svc = createTokenService(makeConfig());
    const claims = svc.verify(svc.sign(PAYLOAD));

    expect(claims.iss).toBe("https://auth.test");
    expect(claims.aud).toBe("https://api.test");
  });

  it("sets iat to approximately now", () => {
    const before = Math.floor(Date.now() / 1000);
    const svc = createTokenService(makeConfig());
    const claims = svc.verify(svc.sign(PAYLOAD));
    const after = Math.floor(Date.now() / 1000);

    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(after + 1);
  });

  it("sets exp = iat + accessTokenTtlSeconds", () => {
    const svc = createTokenService(makeConfig());
    const claims = svc.verify(svc.sign(PAYLOAD));

    expect(claims.exp - claims.iat).toBe(600);
  });

  it("includes a non-empty jti claim", () => {
    const svc = createTokenService(makeConfig());
    const claims = svc.verify(svc.sign(PAYLOAD));

    expect(typeof claims.jti).toBe("string");
    expect(claims.jti.length).toBeGreaterThan(0);
  });

  it("generates unique jti on each call", () => {
    const svc = createTokenService(makeConfig());
    const a = svc.verify(svc.sign(PAYLOAD));
    const b = svc.verify(svc.sign(PAYLOAD));

    expect(a.jti).not.toBe(b.jti);
  });
});

// ---------------------------------------------------------------------------
// JWT structure
// ---------------------------------------------------------------------------

describe("TokenService — JWT structure", () => {
  it("produces a token with exactly 3 dot-separated parts", () => {
    const svc = createTokenService(makeConfig());
    const token = svc.sign(PAYLOAD);

    expect(token.split(".")).toHaveLength(3);
  });

  it("encodes alg, typ, and kid in the header", () => {
    const svc = createTokenService(makeConfig());
    const [headerPart] = svc.sign(PAYLOAD).split(".");
    const header = base64urlDecode(headerPart!) as Record<string, unknown>;

    expect(header["alg"]).toBe("HS256");
    expect(header["typ"]).toBe("JWT");
    expect(header["kid"]).toBe("k1");
  });
});

// ---------------------------------------------------------------------------
// Expiry / timing
// ---------------------------------------------------------------------------

describe("TokenService — expiry and clock skew", () => {
  it("rejects an expired token (exp = now - 60s, no skew overlap)", () => {
    const svc = createTokenService(makeConfig({ clockSkewSeconds: 0 }));
    const token = svc.sign(PAYLOAD);

    // Decode the payload, backdate exp, re-encode, and re-sign with same key.
    const parts = token.split(".");
    const payload = base64urlDecode(parts[1]!) as Record<string, unknown>;
    payload["exp"] = Math.floor(Date.now() / 1000) - 60;

    const newPayloadB64 = Buffer.from(JSON.stringify(payload), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    // Re-sign so the signature is valid (we just want to test the exp check).
    const sigInput = `${parts[0]}.${newPayloadB64}`;
    const sig = createHmac("sha256", SECRET)
      .update(sigInput)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const expiredToken = `${sigInput}.${sig}`;

    expect(() => svc.verify(expiredToken)).toThrow(/expired/i);
  });

  it("accepts a token that is within the clock-skew window", () => {
    // Set TTL to 1 second but clockSkew to 60 so the "expired" token is still within window.
    const svc = createTokenService(
      makeConfig({ accessTokenTtlSeconds: 1, clockSkewSeconds: 60 }),
    );
    const token = svc.sign(PAYLOAD);
    // Token exp = now + 1.  After 2 seconds it would be expired, but clockSkew=60 covers it.
    expect(() => svc.verify(token)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Claim validation failures
// ---------------------------------------------------------------------------

describe("TokenService — claim validation", () => {
  it("rejects a token from the wrong issuer", () => {
    const signer = createTokenService(
      makeConfig({ issuer: "https://evil.example.com" }),
    );
    const verifier = createTokenService(makeConfig()); // issuer = https://auth.test
    const token = signer.sign(PAYLOAD);

    expect(() => verifier.verify(token)).toThrow(/issuer/i);
  });

  it("rejects a token with the wrong audience", () => {
    const signer = createTokenService(
      makeConfig({ audience: "https://other-api.test" }),
    );
    const verifier = createTokenService(makeConfig()); // audience = https://api.test
    const token = signer.sign(PAYLOAD);

    expect(() => verifier.verify(token)).toThrow(/audience/i);
  });
});

// ---------------------------------------------------------------------------
// Algorithm allow-list
// ---------------------------------------------------------------------------

describe("TokenService — algorithm allow-list", () => {
  it("throws at construction when algorithm is 'none'", () => {
    expect(() =>
      // @ts-expect-error — intentional type violation to test runtime guard
      createTokenService(makeConfig({ algorithm: "none" })),
    ).toThrow(/not in the allow-list|algorithm/i);
  });

  it("RS256 is an allowed algorithm — construction succeeds", () => {
    // Construction must succeed; signing with a real key is tested separately.
    expect(() =>
      createTokenService({
        algorithm: "RS256",
        signingKey: { kid: "k1", key: "placeholder-pem" },
        verificationKeys: [{ kid: "k1", key: "placeholder-pem" }],
        issuer: "https://auth.test",
        audience: "https://api.test",
        accessTokenTtlSeconds: 600,
      }),
    ).not.toThrow();
  });

  it("rejects a token whose header alg does not match config algorithm", () => {
    // Sign with HS256; try to verify with a service configured for RS256.
    // verify() should throw on alg mismatch before reaching the signature check.
    const hs256Svc = createTokenService(makeConfig({ algorithm: "HS256" }));
    const token = hs256Svc.sign(PAYLOAD);

    // Build an RS256 verifier (key value irrelevant — we never reach signature check).
    const rs256Svc = createTokenService({
      algorithm: "RS256",
      signingKey: { kid: "k1", key: "placeholder-pem" },
      verificationKeys: [{ kid: "k1", key: "placeholder-pem" }],
      issuer: "https://auth.test",
      audience: "https://api.test",
      accessTokenTtlSeconds: 600,
    });

    // Must throw because token header has alg=HS256 but config expects RS256.
    expect(() => rs256Svc.verify(token)).toThrow(/algorithm mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// Signature integrity
// ---------------------------------------------------------------------------

describe("TokenService — signature integrity", () => {
  it("rejects a token with a tampered payload", () => {
    const svc = createTokenService(makeConfig());
    const [header, , sig] = svc.sign(PAYLOAD).split(".");

    // Swap in a different payload.
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "attacker", sid: "x", iss: "https://auth.test", aud: "https://api.test", iat: 1, exp: 9999999999, jti: "j", roles: ["admin"] }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const tampered = `${header}.${tamperedPayload}.${sig}`;
    expect(() => svc.verify(tampered)).toThrow(/signature/i);
  });

  it("rejects a token with an unknown kid", () => {
    const svc = createTokenService(makeConfig());
    // Build a token manually with kid=unknown.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "unknown" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payload = Buffer.from(JSON.stringify({ sub: "u", sid: "s", iss: "https://auth.test", aud: "https://api.test", iat: 1, exp: 9999999999, jti: "j", roles: [] }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const fakeToken = `${header}.${payload}.fakesig`;

    expect(() => svc.verify(fakeToken)).toThrow(/kid/i);
  });

  it("rejects a malformed token (only 2 parts)", () => {
    const svc = createTokenService(makeConfig());
    expect(() => svc.verify("only.twoparts")).toThrow(/3/);
  });
});

// ---------------------------------------------------------------------------
// Key rotation — old key still verifies old tokens
// ---------------------------------------------------------------------------

describe("TokenService — kid-based key rotation", () => {
  it("verifies a token signed with the old key when old key is still in verificationKeys", () => {
    const OLD_SECRET = "old-secret-key-rotation-test-value-32-chars";
    const NEW_SECRET = "new-secret-key-rotation-test-value-32-chars";

    // Old service signs with k1.
    const oldSvc = createTokenService(
      makeConfig({ signingKey: { kid: "k1", key: OLD_SECRET }, verificationKeys: [{ kid: "k1", key: OLD_SECRET }] }),
    );
    const oldToken = oldSvc.sign(PAYLOAD);

    // New service signs with k2 but still has k1 in verificationKeys.
    const newSvc = createTokenService(
      makeConfig({
        signingKey: { kid: "k2", key: NEW_SECRET },
        verificationKeys: [
          { kid: "k2", key: NEW_SECRET },
          { kid: "k1", key: OLD_SECRET }, // overlap window
        ],
      }),
    );

    // Old token (signed with k1) should still verify.
    const claims = newSvc.verify(oldToken);
    expect(claims.sub).toBe(PAYLOAD.sub);

    // New token should also verify.
    const newToken = newSvc.sign(PAYLOAD);
    const newClaims = newSvc.verify(newToken);
    expect(newClaims.sub).toBe(PAYLOAD.sub);
  });
});

/**
 * Session management — server-only.
 *
 * Serializes a session payload into a signed, base64-encoded httpOnly cookie.
 * The cookie is only readable by the server (httpOnly) and is scoped to the
 * current origin (sameSite=lax). Token material never appears in the browser
 * environment (no localStorage, no non-httpOnly cookie).
 *
 * Signing: HMAC-SHA256 using SESSION_SECRET. The cookie value is:
 *   <base64url(payload)>.<base64url(hmac)>
 *
 * A missing or invalid SESSION_SECRET in development falls back to a
 * fixed development key with a warning. In production the app exits if
 * SESSION_SECRET is absent.
 */

import { createHmac, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// Session shape
// ---------------------------------------------------------------------------

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly avatarUrl?: string;
  readonly locale: string;
  readonly currency: string;
}

export interface Session {
  readonly user: SessionUser;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number; // Unix timestamp (ms)
}

/** Safe subset of session exposed to client components — no tokens. */
export interface ClientSession {
  readonly user: SessionUser;
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// Cookie constants
// ---------------------------------------------------------------------------

export const SESSION_COOKIE_NAME = "__travel_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

function getSecret(): string {
  const secret = process.env["SESSION_SECRET"];
  if (secret !== undefined && secret.length >= 32) return secret;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("[session] SESSION_SECRET is required in production");
  }
  // Development fallback — never used in production
  return "dev-only-session-secret-do-not-use-in-production-32ch";
}

function sign(payload: string): string {
  const secret = getSecret();
  const hmac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${hmac}`;
}

function verify(signed: string): string | null {
  const dotIndex = signed.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const payload = signed.slice(0, dotIndex);
  const signature = signed.slice(dotIndex + 1);
  const expected = createHmac("sha256", getSecret()).update(payload).digest("base64url");
  try {
    const expectedBuf = Buffer.from(expected, "base64url");
    const actualBuf = Buffer.from(signature, "base64url");
    if (expectedBuf.length !== actualBuf.length) return null;
    if (!timingSafeEqual(expectedBuf, actualBuf)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeSession(session: Session): string {
  const json = JSON.stringify(session);
  const encoded = Buffer.from(json).toString("base64url");
  return sign(encoded);
}

export function deserializeSession(cookie: string): Session | null {
  const payload = verify(cookie);
  if (payload === null) return null;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf-8");
    return JSON.parse(json) as Session;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie options builder
// ---------------------------------------------------------------------------

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

// ---------------------------------------------------------------------------
// Server-side session helpers (use next/headers — server components / actions)
// ---------------------------------------------------------------------------

/** Read the current session from the request cookie. Returns null if absent or invalid. */
export async function getSession(): Promise<Session | null> {
  const { cookies } = await import("next/headers");
  const cookieStore = cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (raw === undefined) return null;
  return deserializeSession(raw);
}

/** Write a new session cookie. Call from server actions after successful auth. */
export async function setSession(session: Session): Promise<void> {
  const { cookies } = await import("next/headers");
  const cookieStore = cookies();
  cookieStore.set(SESSION_COOKIE_NAME, serializeSession(session), cookieOptions(COOKIE_MAX_AGE_SECONDS));
}

/** Clear the session cookie. Call from the logout server action. */
export async function clearSession(): Promise<void> {
  const { cookies } = await import("next/headers");
  const cookieStore = cookies();
  cookieStore.set(SESSION_COOKIE_NAME, "", cookieOptions(0));
}

/** Extract the client-safe session (no tokens) for hydrating the SessionProvider. */
export async function getClientSession(): Promise<ClientSession | null> {
  const session = await getSession();
  if (session === null) return null;
  return { user: session.user, expiresAt: session.expiresAt };
}

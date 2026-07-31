/**
 * Next.js middleware for authentication.
 *
 * - Protected routes: redirects unauthenticated users to /sign-in?returnTo=<current path>
 * - Auth-only routes: redirects authenticated users away from sign-in/sign-up to /account
 * - Session is read from the signed httpOnly cookie (no DB call needed)
 */

import { type NextRequest, NextResponse } from "next/server";
import { deserializeSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";

// ---------------------------------------------------------------------------
// Route matchers
// ---------------------------------------------------------------------------

/** Routes that require an authenticated session. */
const PROTECTED_PREFIXES = [
  "/account",
  "/profile",
  "/checkout",
  "/bookings",
];

/** Routes that authenticated users should not see (sign-in, sign-up). */
const AUTH_ONLY_PREFIXES = [
  "/sign-in",
  "/sign-up",
];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isAuthOnly(pathname: string): boolean {
  return AUTH_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const rawCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = rawCookie !== undefined ? deserializeSession(rawCookie) : null;
  const isAuthenticated = session !== null && session.expiresAt > Date.now();

  if (isProtected(pathname) && !isAuthenticated) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("returnTo", pathname + request.nextUrl.search);
    return NextResponse.redirect(signInUrl);
  }

  if (isAuthOnly(pathname) && isAuthenticated) {
    const returnTo = request.nextUrl.searchParams.get("returnTo");
    const destination = sanitizeReturnTo(returnTo) ?? "/account";
    return NextResponse.redirect(new URL(destination, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static  (static files)
     * - _next/image   (image optimization)
     * - favicon.ico
     * - api/ routes (handled by route handlers, not middleware)
     * - public files (images, etc.)
     */
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
  ],
};

// ---------------------------------------------------------------------------
// Inline sanitizeReturnTo (cannot import server actions in middleware)
// ---------------------------------------------------------------------------

function sanitizeReturnTo(returnTo: string | null | undefined): string | null {
  if (returnTo === undefined || returnTo === null || returnTo === "") return null;
  if (returnTo.startsWith("//") || returnTo.startsWith("http://") || returnTo.startsWith("https://")) {
    return null;
  }
  if (!returnTo.startsWith("/")) return null;
  if (returnTo.startsWith("/sign-in") || returnTo.startsWith("/sign-up")) return null;
  return returnTo;
}

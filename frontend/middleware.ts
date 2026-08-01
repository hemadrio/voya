/**
 * Next.js middleware — locale negotiation + authentication guard.
 *
 * Order of operations:
 *   1. Locale negotiation: reads NEXT_LOCALE cookie → Accept-Language header → default "en"
 *      - Rewrites or redirects to locale-prefixed path
 *      - Sets x-locale header so the root layout can read the active locale
 *   2. Auth guard: redirects unauthenticated users away from protected routes
 *   3. Auth-only guard: redirects authenticated users away from sign-in/sign-up
 *
 * All search params are preserved when rewriting or redirecting.
 */

import { type NextRequest, NextResponse } from "next/server";
import { deserializeSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";

// ---------------------------------------------------------------------------
// Locale config (inline to avoid ESM import issues in Edge runtime)
// ---------------------------------------------------------------------------

const SUPPORTED_LOCALES = ["en", "es", "ar"] as const;
const DEFAULT_LOCALE = "en";
const LOCALE_COOKIE_NAME = "NEXT_LOCALE";
const LOCALE_HEADER = "x-locale";

function isSupportedLocale(s: string): s is (typeof SUPPORTED_LOCALES)[number] {
  return (SUPPORTED_LOCALES as readonly string[]).includes(s);
}

function parseAcceptLanguage(header: string): string[] {
  return header
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";");
      const quality = q ? parseFloat(q.replace("q=", "").trim()) : 1.0;
      return { tag: (tag ?? "").trim(), q: quality };
    })
    .filter((x) => x.tag.length > 0)
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag);
}

function matchLocale(tag: string): string | null {
  const lower = tag.toLowerCase();
  for (const locale of SUPPORTED_LOCALES) {
    if (locale.toLowerCase() === lower) return locale;
  }
  const lang = lower.split("-")[0];
  if (lang) {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale.toLowerCase() === lang) return locale;
    }
  }
  return null;
}

function negotiateLocale(request: NextRequest): string {
  const cookieLocale = request.cookies.get(LOCALE_COOKIE_NAME)?.value;
  if (cookieLocale && isSupportedLocale(cookieLocale)) return cookieLocale;

  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage) {
    for (const tag of parseAcceptLanguage(acceptLanguage)) {
      const match = matchLocale(tag);
      if (match) return match;
    }
  }

  return DEFAULT_LOCALE;
}

// ---------------------------------------------------------------------------
// Route matchers (strip locale prefix before checking)
// ---------------------------------------------------------------------------

const PROTECTED_SUFFIXES = ["/account", "/profile", "/checkout", "/bookings"];
const AUTH_ONLY_SUFFIXES = ["/sign-in", "/sign-up"];

function stripLocalePrefix(pathname: string): string {
  for (const locale of SUPPORTED_LOCALES) {
    if (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)) {
      return pathname.slice(locale.length + 1) || "/";
    }
  }
  return pathname;
}

function isProtected(pathname: string): boolean {
  const bare = stripLocalePrefix(pathname);
  return PROTECTED_SUFFIXES.some((p) => bare === p || bare.startsWith(p + "/"));
}

function isAuthOnly(pathname: string): boolean {
  const bare = stripLocalePrefix(pathname);
  return AUTH_ONLY_SUFFIXES.some((p) => bare === p || bare.startsWith(p + "/"));
}

function hasLocalePrefix(pathname: string): boolean {
  for (const locale of SUPPORTED_LOCALES) {
    if (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const locale = negotiateLocale(request);

  // Step 1: Locale rewrite/redirect
  if (!hasLocalePrefix(pathname)) {
    // Redirect non-prefixed path to locale-prefixed equivalent, preserving search params
    const localeUrl = new URL(request.url);
    localeUrl.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
    const response = NextResponse.redirect(localeUrl);
    response.headers.set(LOCALE_HEADER, locale);
    return response;
  }

  // Step 2: Auth guard
  const rawCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = rawCookie !== undefined ? deserializeSession(rawCookie) : null;
  const isAuthenticated = session !== null && session.expiresAt > Date.now();

  if (isProtected(pathname) && !isAuthenticated) {
    const bare = stripLocalePrefix(pathname);
    const signInUrl = new URL(`/${locale}/sign-in`, request.url);
    signInUrl.searchParams.set("returnTo", bare + request.nextUrl.search);
    const response = NextResponse.redirect(signInUrl);
    response.headers.set(LOCALE_HEADER, locale);
    return response;
  }

  if (isAuthOnly(pathname) && isAuthenticated) {
    const returnTo = request.nextUrl.searchParams.get("returnTo");
    const destination = sanitizeReturnTo(returnTo) ?? `/${locale}/account`;
    const response = NextResponse.redirect(new URL(destination, request.url));
    response.headers.set(LOCALE_HEADER, locale);
    return response;
  }

  // Step 3: Pass through — attach locale header so the root layout can read it
  const response = NextResponse.next();
  response.headers.set(LOCALE_HEADER, locale);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static  (Next.js static files)
     * - _next/image   (image optimization)
     * - favicon.ico
     * - api/ routes   (route handlers, not middleware)
     * - public assets (images, fonts, etc.)
     */
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeReturnTo(returnTo: string | null | undefined): string | null {
  if (!returnTo) return null;
  if (returnTo.startsWith("//") || returnTo.startsWith("http://") || returnTo.startsWith("https://")) {
    return null;
  }
  if (!returnTo.startsWith("/")) return null;
  if (returnTo.startsWith("/sign-in") || returnTo.startsWith("/sign-up")) return null;
  return returnTo;
}

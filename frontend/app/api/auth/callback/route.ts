import { type NextRequest, NextResponse } from "next/server";
import { setSession } from "@/lib/auth/session";
import { env } from "@/lib/env";

interface OAuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl?: string;
    locale: string;
    currency: string;
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error !== null) {
    return NextResponse.redirect(new URL(`/sign-in?error=${encodeURIComponent(error)}`, request.url));
  }

  if (code === null) {
    return NextResponse.redirect(new URL("/sign-in?error=missing_code", request.url));
  }

  const api = env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${api}/auth/oauth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    });
  } catch {
    return NextResponse.redirect(new URL("/sign-in?error=upstream_error", request.url));
  }

  if (!res.ok) {
    return NextResponse.redirect(new URL("/sign-in?error=oauth_failed", request.url));
  }

  const data = (await res.json()) as OAuthTokenResponse;
  await setSession({
    user: {
      id: data.user.id,
      email: data.user.email,
      firstName: data.user.firstName,
      lastName: data.user.lastName,
      ...(data.user.avatarUrl !== undefined ? { avatarUrl: data.user.avatarUrl } : {}),
      locale: data.user.locale,
      currency: data.user.currency,
    },
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + data.expiresIn * 1000,
  });

  const returnTo = decodeAndValidateState(state);
  return NextResponse.redirect(new URL(returnTo ?? "/account", request.url));
}

function decodeAndValidateState(state: string | null): string | null {
  if (state === null) return null;
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf-8")) as { returnTo?: string };
    const returnTo = decoded.returnTo;
    if (typeof returnTo !== "string") return null;
    if (!returnTo.startsWith("/")) return null;
    if (returnTo.startsWith("/sign-in") || returnTo.startsWith("/sign-up")) return null;
    return returnTo;
  } catch {
    return null;
  }
}

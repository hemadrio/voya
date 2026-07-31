import { NextResponse } from "next/server";
import { getSession, setSession } from "@/lib/auth/session";
import { env } from "@/lib/env";

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function POST(): Promise<NextResponse> {
  const session = await getSession();
  if (session === null) {
    return NextResponse.json({ error: "No session" }, { status: 401 });
  }

  const api = env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${api}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
  } catch {
    return NextResponse.json({ error: "Upstream unavailable" }, { status: 502 });
  }

  if (!res.ok) {
    return NextResponse.json({ error: "Refresh failed" }, { status: 401 });
  }

  const data = (await res.json()) as RefreshResponse;
  await setSession({
    ...session,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + data.expiresIn * 1000,
  });

  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth/session";

export async function GET(): Promise<NextResponse> {
  const session = await getClientSession();
  if (session === null) {
    return NextResponse.json(null, { status: 401 });
  }
  return NextResponse.json(session);
}

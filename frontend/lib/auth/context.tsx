"use client";

/**
 * Client-side session context.
 *
 * SessionProvider is hydrated from a server-rendered ClientSession payload
 * (user profile + expiry, no tokens). Token material never reaches the browser.
 *
 * After sign-in or sign-out, call refreshSession() to update the context
 * without a full page reload by re-fetching from /api/auth/me.
 */

import * as React from "react";
import type { ClientSession } from "./session";

interface SessionContextValue {
  readonly session: ClientSession | null;
  readonly isLoading: boolean;
  refreshSession(): Promise<void>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  readonly children: React.ReactNode;
  readonly initialSession: ClientSession | null;
}

export function SessionProvider({ children, initialSession }: SessionProviderProps) {
  const [session, setSession] = React.useState<ClientSession | null>(initialSession);
  const [isLoading, setIsLoading] = React.useState(false);

  const refreshSession = React.useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as ClientSession;
        setSession(data);
      } else {
        setSession(null);
      }
    } catch {
      // Network error — keep existing session rather than clearing
    } finally {
      setIsLoading(false);
    }
  }, []);

  const value = React.useMemo<SessionContextValue>(
    () => ({ session, isLoading, refreshSession }),
    [session, isLoading, refreshSession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = React.useContext(SessionContext);
  if (ctx === null) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return ctx;
}

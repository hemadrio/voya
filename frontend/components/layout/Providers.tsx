"use client";

import * as React from "react";
import { ToastProvider } from "@/components/ui/Toast.js";
import { SessionProvider } from "@/lib/auth/context";
import type { ClientSession } from "@/lib/auth/session";

interface ProvidersProps {
  readonly children: React.ReactNode;
  readonly initialSession: ClientSession | null;
}

export function Providers({ children, initialSession }: ProvidersProps) {
  return (
    <ToastProvider>
      <SessionProvider initialSession={initialSession}>{children}</SessionProvider>
    </ToastProvider>
  );
}

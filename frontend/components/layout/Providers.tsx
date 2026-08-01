"use client";

import * as React from "react";
import { ToastProvider } from "@/components/ui/Toast.js";
import { SessionProvider } from "@/lib/auth/context";
import type { ClientSession } from "@/lib/auth/session";
import { useI18n, useCurrency } from "@/lib/i18n/context.js";
import { setLocaleProvider } from "@/lib/api/client.js";

interface ProvidersProps {
  readonly children: React.ReactNode;
  readonly initialSession: ClientSession | null;
}

/**
 * Wires the locale + currency context into the API client so every fetch
 * automatically carries the active locale/currency without call-site changes.
 */
function LocaleApiSync() {
  const { locale } = useI18n();
  const { currency } = useCurrency();

  React.useEffect(() => {
    setLocaleProvider(() => ({ locale, currency }));
  }, [locale, currency]);

  return null;
}

export function Providers({ children, initialSession }: ProvidersProps) {
  return (
    <ToastProvider>
      <SessionProvider initialSession={initialSession}>
        <LocaleApiSync />
        {children}
      </SessionProvider>
    </ToastProvider>
  );
}

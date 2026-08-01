import type { ReactNode } from "react";
import { SiteHeader } from "@/components/layout/SiteHeader.js";
import { SiteFooter } from "@/components/layout/SiteFooter.js";
import { Providers } from "@/components/layout/Providers.js";
import { RootErrorBoundary } from "@/components/layout/RootErrorBoundary.js";
import { SkipToContent } from "@/components/layout/SkipToContent.js";
import { I18nProvider, CurrencyProvider } from "@/lib/i18n/context.js";
import { getClientSession } from "@/lib/auth/session";
import { loadMessages } from "../../i18n/request.js";
import { isSupportedLocale, CURRENCY_COOKIE_NAME } from "../../i18n/routing.js";
import { DEFAULT_LOCALE } from "../../i18n/routing.js";
import { DEFAULT_CURRENCY, isSupportedCurrency } from "@/lib/i18n/currency.js";
import { cookies } from "next/headers";
import type { SupportedCurrency } from "@/lib/i18n/currency.js";

interface LocaleLayoutProps {
  children: ReactNode;
  params: { locale: string };
}

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const locale = isSupportedLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const messages = await loadMessages(locale);

  const initialSession = await getClientSession();

  const currencyCookie = cookies().get(CURRENCY_COOKIE_NAME)?.value;
  const initialCurrency: SupportedCurrency =
    currencyCookie && isSupportedCurrency(currencyCookie) ? currencyCookie : DEFAULT_CURRENCY;

  return (
    <I18nProvider locale={locale} messages={messages}>
      <CurrencyProvider initialCurrency={initialCurrency}>
        <SkipToContent />
        <Providers initialSession={initialSession}>
          <SiteHeader />
          <RootErrorBoundary>
            <main id="main-content" className="flex-1" tabIndex={-1}>
              {children}
            </main>
          </RootErrorBoundary>
          <SiteFooter />
        </Providers>
      </CurrencyProvider>
    </I18nProvider>
  );
}

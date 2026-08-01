import Link from "next/link";
import type { Metadata } from "next";
import { buttonVariants } from "@/components/ui/Button.js";
import { cn } from "@/lib/utils.js";
import { loadMessages } from "../../i18n/request.js";
import { isSupportedLocale } from "../../i18n/routing.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../i18n/routing.js";

interface HomePageProps {
  params: { locale: string };
}

export async function generateMetadata({ params }: HomePageProps): Promise<Metadata> {
  const locale = isSupportedLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const messages = await loadMessages(locale);
  const msg = messages as Record<string, Record<string, string>>;
  const title = msg["home"]?.["title"] ?? "TravelPlatform";
  const description = msg["home"]?.["subtitle"] ?? "AI-powered travel booking.";

  const BASE_URL = process.env["NEXT_PUBLIC_BASE_URL"] ?? "https://travelplatform.example.com";

  return {
    title,
    description,
    alternates: {
      canonical: `${BASE_URL}/${locale}`,
      languages: Object.fromEntries(
        SUPPORTED_LOCALES.map((l) => [l, `${BASE_URL}/${l}`])
      ) as Record<string, string>,
    },
    openGraph: {
      title,
      description,
      locale,
    },
  };
}

export default async function HomePage({ params }: HomePageProps) {
  const locale = isSupportedLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const messages = await loadMessages(locale);
  const msg = messages as Record<string, Record<string, string | Record<string, string>>>;
  const home = (msg["home"] ?? {}) as { title?: string; subtitle?: string; cta?: { flights?: string; hotels?: string } };

  return (
    <div className="mx-auto max-w-[80rem] px-4 py-16 sm:px-6 lg:px-8">
      <div className="flex flex-col items-center gap-8 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-neutral-900 sm:text-5xl">
          {home.title ?? "Your journey starts here"}
        </h1>
        <p className="max-w-xl text-lg text-neutral-600">
          {home.subtitle ?? "Search flights, hotels, and cars from hundreds of suppliers."}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            href={`/${locale}/search?tab=FLIGHT`}
            className={cn(buttonVariants({ variant: "primary", size: "lg" }))}
          >
            {home.cta?.flights ?? "Search Flights"}
          </Link>
          <Link
            href={`/${locale}/search?tab=HOTEL`}
            className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}
          >
            {home.cta?.hotels ?? "Find Hotels"}
          </Link>
        </div>
      </div>
    </div>
  );
}

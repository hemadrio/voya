import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Suspense } from "react";
import dynamic from "next/dynamic";
import { getListing, getReviews } from "@/lib/api/listings.js";
import { ListingHeader } from "@/components/listing/ListingHeader.js";
import { PhotoGallery } from "@/components/listing/PhotoGallery.js";
import { AmenitiesGrid } from "@/components/listing/AmenitiesGrid.js";
import { PoliciesSection } from "@/components/listing/PoliciesSection.js";
import { HostCard } from "@/components/listing/HostCard.js";
import { ReviewsSection } from "@/components/listing/ReviewsSection.js";
import { BookingWidget } from "@/components/listing/BookingWidget.js";
import { MobileReserveBar } from "@/components/listing/MobileReserveBar.js";

// Dynamically imported with ssr:false — exact coordinates never exposed in the server render
const ApproximateLocationMap = dynamic(
  () => import("@/components/listing/ApproximateLocationMap.js").then((m) => m.ApproximateLocationMap),
  { ssr: false },
);

interface ListingPageProps {
  params: { slug: string };
}

export async function generateMetadata({ params }: ListingPageProps): Promise<Metadata> {
  try {
    const listing = await getListing(params.slug);
    return {
      title: `${listing.title} — ${listing.approximateLocation.city}`,
      description: listing.description.slice(0, 160),
      openGraph: {
        title: listing.title,
        description: listing.description.slice(0, 160),
        images: listing.images[0] ? [{ url: listing.images[0].url, alt: listing.images[0].alt }] : [],
      },
    };
  } catch {
    return { title: "Listing not found" };
  }
}

export default async function ListingPage({ params }: ListingPageProps) {
  let listing;
  try {
    listing = await getListing(params.slug);
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 404) notFound();
    throw err;
  }

  // Fetch initial reviews page in parallel — non-fatal if it fails
  let initialReviews = { items: [] as Awaited<ReturnType<typeof getReviews>>["items"], nextCursor: null as string | null };
  try {
    const rev = await getReviews(listing.id, { sort: "relevance" });
    initialReviews = { items: rev.items, nextCursor: rev.nextCursor };
  } catch {
    // ReviewsSection will show empty state
  }

  return (
    <>
      <main className="mx-auto max-w-7xl px-4 pb-20 pt-6 sm:pb-6 sm:px-6 lg:px-8">
        <ListingHeader listing={listing} />

        <div className="mt-4">
          <PhotoGallery images={listing.images} title={listing.title} />
        </div>

        <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_380px]">
          {/* Left column */}
          <div className="space-y-10 min-w-0">
            {/* Description */}
            <section aria-labelledby="description-heading">
              <h2 id="description-heading" className="mb-3 text-xl font-semibold text-neutral-900">
                About this place
              </h2>
              {listing.highlights.length > 0 && (
                <ul className="mb-3 space-y-1">
                  {listing.highlights.map((h) => (
                    <li key={h} className="flex items-start gap-2 text-sm text-neutral-700">
                      <span aria-hidden="true" className="mt-0.5 flex-shrink-0">✓</span>
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-sm leading-relaxed text-neutral-700 whitespace-pre-line">
                {listing.description}
              </p>
            </section>

            <AmenitiesGrid amenities={listing.amenities} />

            <HostCard host={listing.host} />

            <PoliciesSection policies={listing.policies} />

            <ApproximateLocationMap location={listing.approximateLocation} />

            {listing.rating.count > 0 && (
              <Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-neutral-100" />}>
                <ReviewsSection
                  listingId={listing.id}
                  rating={listing.rating}
                  initialReviews={initialReviews.items}
                  initialCursor={initialReviews.nextCursor}
                />
              </Suspense>
            )}
          </div>

          {/* Right column — booking widget */}
          <div className="relative hidden lg:block">
            <div id="booking-widget" className="sticky top-24">
              <BookingWidget listing={listing} />
            </div>
          </div>
        </div>

        {/* Mobile booking widget */}
        <div id="booking-widget" className="mt-10 lg:hidden">
          <BookingWidget listing={listing} />
        </div>
      </main>

      <MobileReserveBar currency={listing.currency} listingSlug={listing.slug} />
    </>
  );
}

export const dynamic = "force-dynamic";

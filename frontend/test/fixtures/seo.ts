/**
 * SEO test fixtures — structured data snapshots and sitemap entries.
 */

import type {
  OrganizationData,
  LodgingBusinessData,
  ProductData,
  FAQItem,
  BreadcrumbItem,
} from "@/lib/seo/structuredData";

export const FIXTURE_ORGANIZATION: OrganizationData = {
  name: "TravelPlatform",
  url: "https://travelplatform.example.com",
  logo: "https://travelplatform.example.com/logo.png",
  sameAs: ["https://twitter.com/travelplatform", "https://linkedin.com/company/travelplatform"],
  contactEmail: "support@travelplatform.example.com",
};

export const FIXTURE_BREADCRUMBS: readonly BreadcrumbItem[] = [
  { name: "Home", url: "https://travelplatform.example.com/" },
  { name: "Hotels", url: "https://travelplatform.example.com/search?tab=HOTEL" },
  { name: "Marriott Paris", url: "https://travelplatform.example.com/hotels/marriott-paris" },
];

export const FIXTURE_LODGING_WITH_REVIEWS: LodgingBusinessData = {
  name: "Grand Marriott Paris",
  url: "https://travelplatform.example.com/hotels/marriott-paris",
  description: "5-star hotel in central Paris with panoramic views.",
  image: ["https://cdn.travelplatform.example.com/hotels/marriott-paris-1.jpg"],
  address: {
    streetAddress: "40 Rue du Colisée",
    addressLocality: "Paris",
    addressCountry: "FR",
  },
  priceRange: "€€€€",
  reviewCount: 2847,
  ratingValue: 4.6,
  offers: [
    {
      price: 420,
      priceCurrency: "EUR",
      checkinDate: "2026-08-15",
      checkoutDate: "2026-08-18",
      availability: "InStock",
    },
  ],
};

export const FIXTURE_LODGING_NO_REVIEWS: LodgingBusinessData = {
  name: "New Boutique Hotel",
  url: "https://travelplatform.example.com/hotels/new-boutique",
  description: "Brand new property opening 2026.",
  address: {
    addressLocality: "Barcelona",
    addressCountry: "ES",
  },
  // reviewCount is 0 — aggregateRating must be OMITTED
  reviewCount: 0,
  ratingValue: undefined,
};

export const FIXTURE_PRODUCT: ProductData = {
  name: "Nonstop JFK → CDG Economy",
  description: "Direct flight from New York to Paris — 7h 15m",
  brand: "Air France",
  sku: "AF0023-2026-08-15",
  reviewCount: 512,
  ratingValue: 4.2,
  offers: [
    {
      price: 789,
      priceCurrency: "USD",
      availability: "LimitedAvailability",
      validThrough: "2026-08-15T23:59:59Z",
    },
  ],
};

export const FIXTURE_FAQ: readonly FAQItem[] = [
  {
    question: "How do I cancel a booking?",
    answer:
      "You can cancel a booking from your account page within 24 hours of booking for a full refund.",
  },
  {
    question: "Is my payment information secure?",
    answer:
      "Yes. All payment data is processed directly by Stripe and never stored on our servers.",
  },
];

// Expected JSON-LD shapes for snapshot testing
export const EXPECTED_ORGANIZATION_TYPE = "Organization";
export const EXPECTED_BREADCRUMB_TYPE = "BreadcrumbList";
export const EXPECTED_LODGING_TYPE = "LodgingBusiness";
export const EXPECTED_PRODUCT_TYPE = "Product";
export const EXPECTED_FAQ_TYPE = "FAQPage";

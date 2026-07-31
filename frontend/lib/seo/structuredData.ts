/**
 * JSON-LD structured data serializers.
 *
 * Each serializer returns a plain object that can be injected as:
 *   <script type="application/ld+json">{JSON.stringify(serialize*(...))}></script>
 *
 * Constraints:
 * - aggregateRating MUST be omitted when reviewCount is 0 or undefined.
 * - Checkout and account pages must not receive structured data.
 */

// ---------------------------------------------------------------------------
// Schema.org primitive types
// ---------------------------------------------------------------------------

type SchemaOrgType = string | string[];

interface SchemaOrgBase {
  "@context": "https://schema.org";
  "@type": SchemaOrgType;
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export interface OrganizationData {
  name: string;
  url: string;
  logo?: string;
  sameAs?: string[];
  contactEmail?: string;
}

export function serializeOrganization(data: OrganizationData): SchemaOrgBase & Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: data.name,
    url: data.url,
    ...(data.logo !== undefined ? { logo: { "@type": "ImageObject", url: data.logo } } : {}),
    ...(data.sameAs !== undefined && data.sameAs.length > 0 ? { sameAs: data.sameAs } : {}),
    ...(data.contactEmail !== undefined
      ? {
          contactPoint: {
            "@type": "ContactPoint",
            email: data.contactEmail,
            contactType: "customer service",
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// BreadcrumbList
// ---------------------------------------------------------------------------

export interface BreadcrumbItem {
  name: string;
  url: string;
}

export function serializeBreadcrumbs(items: readonly BreadcrumbItem[]): SchemaOrgBase & Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

// ---------------------------------------------------------------------------
// LodgingBusiness (hotels)
// ---------------------------------------------------------------------------

export interface LodgingBusinessData {
  name: string;
  url: string;
  description?: string;
  image?: string[];
  address?: {
    streetAddress?: string;
    addressLocality: string;
    addressCountry: string;
  };
  priceRange?: string;
  reviewCount?: number;
  ratingValue?: number;
  offers?: Array<{
    price: number;
    priceCurrency: string;
    checkinDate?: string;
    checkoutDate?: string;
    availability?: "InStock" | "LimitedAvailability" | "SoldOut";
  }>;
}

export function serializeLodgingBusiness(
  data: LodgingBusinessData,
): SchemaOrgBase & Record<string, unknown> {
  const hasReviews =
    data.reviewCount !== undefined &&
    data.reviewCount > 0 &&
    data.ratingValue !== undefined;

  return {
    "@context": "https://schema.org",
    "@type": "LodgingBusiness",
    name: data.name,
    url: data.url,
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.image !== undefined && data.image.length > 0 ? { image: data.image } : {}),
    ...(data.address !== undefined
      ? {
          address: {
            "@type": "PostalAddress",
            ...(data.address.streetAddress !== undefined
              ? { streetAddress: data.address.streetAddress }
              : {}),
            addressLocality: data.address.addressLocality,
            addressCountry: data.address.addressCountry,
          },
        }
      : {}),
    ...(data.priceRange !== undefined ? { priceRange: data.priceRange } : {}),
    // aggregateRating is only emitted when there are actual reviews (AC edge case)
    ...(hasReviews
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: data.ratingValue,
            reviewCount: data.reviewCount,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
    ...(data.offers !== undefined && data.offers.length > 0
      ? {
          makesOffer: data.offers.map((o) => ({
            "@type": "Offer",
            price: o.price,
            priceCurrency: o.priceCurrency,
            availability: `https://schema.org/${o.availability ?? "InStock"}`,
            ...(o.checkinDate !== undefined ? { checkinTime: o.checkinDate } : {}),
            ...(o.checkoutDate !== undefined ? { checkoutTime: o.checkoutDate } : {}),
          })),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Product (flight / car offers)
// ---------------------------------------------------------------------------

export interface ProductData {
  name: string;
  description?: string;
  image?: string;
  brand?: string;
  sku?: string;
  reviewCount?: number;
  ratingValue?: number;
  offers?: Array<{
    price: number;
    priceCurrency: string;
    availability?: "InStock" | "LimitedAvailability" | "SoldOut";
    validThrough?: string;
    url?: string;
  }>;
}

export function serializeProduct(data: ProductData): SchemaOrgBase & Record<string, unknown> {
  const hasReviews =
    data.reviewCount !== undefined &&
    data.reviewCount > 0 &&
    data.ratingValue !== undefined;

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: data.name,
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.image !== undefined ? { image: data.image } : {}),
    ...(data.brand !== undefined
      ? { brand: { "@type": "Brand", name: data.brand } }
      : {}),
    ...(data.sku !== undefined ? { sku: data.sku } : {}),
    ...(hasReviews
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: data.ratingValue,
            reviewCount: data.reviewCount,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
    ...(data.offers !== undefined && data.offers.length > 0
      ? {
          offers: data.offers.map((o) => ({
            "@type": "Offer",
            price: o.price,
            priceCurrency: o.priceCurrency,
            availability: `https://schema.org/${o.availability ?? "InStock"}`,
            ...(o.validThrough !== undefined ? { priceValidUntil: o.validThrough } : {}),
            ...(o.url !== undefined ? { url: o.url } : {}),
          })),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// FAQPage
// ---------------------------------------------------------------------------

export interface FAQItem {
  question: string;
  answer: string;
}

export function serializeFAQ(items: readonly FAQItem[]): SchemaOrgBase & Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render a JSON-LD script tag string (use dangerouslySetInnerHTML in React). */
export function toJsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 0);
}

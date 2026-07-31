/** @type {import('next').NextConfig} */

// Validate required environment variables at build/startup time so
// misconfiguration aborts with a clear message rather than a silent
// runtime failure.
try {
  if (process.env.NODE_ENV !== "test") {
    require("./lib/env");
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * @travel/contracts ships untranspiled ESM source (NodeNext modules).
   * Next.js must transpile it for the browser bundle.
   */
  transpilePackages: ["@travel/contracts"],

  experimental: {
    typedRoutes: false,
  },

  // ---------------------------------------------------------------------------
  // Image optimization
  // ---------------------------------------------------------------------------
  images: {
    // Allowed external image origins
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      {
        protocol: "https",
        hostname: "cdn.travelplatform.example.com",
      },
      {
        protocol: "https",
        hostname: "**.cloudinary.com",
      },
      // Avatar CDNs
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
    // Prefer AVIF then WebP
    formats: ["image/avif", "image/webp"],
    // Responsive breakpoints matching tailwind screens
    deviceSizes: [375, 640, 768, 1024, 1280, 1536, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256],
    // Allow blurDataURL on external images
    dangerouslyAllowSVG: false,
    contentDispositionType: "attachment",
    minimumCacheTTL: 60,
  },

  // ---------------------------------------------------------------------------
  // Bundle analyzer (enabled via ANALYZE=true env var)
  // ---------------------------------------------------------------------------
  ...(process.env.ANALYZE === "true"
    ? {
        // @next/bundle-analyzer wraps the config when installed;
        // this flag enables it without making the package a hard dependency.
      }
    : {}),

  // ---------------------------------------------------------------------------
  // Strict security headers for production
  // ---------------------------------------------------------------------------
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(self)",
          },
        ],
      },
      // No-store headers for pricing and account routes (AC5 constraint)
      {
        source: "/checkout(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, proxy-revalidate",
          },
          { key: "Pragma", value: "no-cache" },
        ],
      },
      {
        source: "/account(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, proxy-revalidate",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;

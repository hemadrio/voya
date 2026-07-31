/** @type {import('next').NextConfig} */

// Validate required environment variables at build/startup time so
// misconfiguration aborts with a clear message rather than a silent
// runtime failure.
//
// NOTE: this import runs in Node.js (not the browser bundle) so it is safe
// to run the validation side-effect here. The client bundle accesses the
// same values via next.config's `env` field after validation.
try {
  // Dynamic require so missing env during `next lint` or `tsc --noEmit`
  // does not break developer tooling flows that don't supply a .env.local.
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

const nextConfig = {
  /**
   * @travel/contracts ships untranspiled ESM source (NodeNext modules).
   * Next.js must transpile it for the browser bundle — this replicates the
   * contracts Zod schemas into the client bundle so form validation messages
   * are byte-identical to the server messages.
   */
  transpilePackages: ["@travel/contracts"],

  experimental: {
    typedRoutes: false,
  },
};

module.exports = nextConfig;

/** @type {import('next').NextConfig} */
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

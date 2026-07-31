/**
 * @travel/contracts — root barrel.
 *
 * Re-exports every domain module (search, booking, payment, auth, user,
 * events) plus the shared `common` primitives/enums. This is the single
 * authoritative source of request, response, event, and enum shapes for
 * every service and the web app; TypeScript types are always derived from
 * the Zod schemas via `z.infer`, never hand-written separately.
 */
export * as common from "./common/index.js";
export * from "./search/index.js";
export * from "./booking/index.js";
export * from "./payment/index.js";
export * from "./auth/index.js";
export * from "./user/index.js";
export * from "./events/index.js";

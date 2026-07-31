# @travel/contracts

Single authoritative source of Zod schemas — and the TypeScript types
inferred from them — for every request, response, event, and enum shape
shared across the travel platform's nine services and the Next.js web app.

This package is the root of the Turborepo dependency graph: every other
workspace target depends on its build output, either directly (`import`) or
transitively. Because of that fan-in, it is intentionally **dependency-light**
— `zod` is its only runtime dependency, and it must never import Express,
Prisma, or any vendor SDK (Stripe, the Anthropic SDK, an AWS SDK, ...). See
`test/dependency-boundary.test.ts` and the `no-restricted-imports` ESLint
rule in `.eslintrc.cjs` for the two independent gates that enforce this.

## Module layout

```
src/
  common/     Shared primitives (IATA code, ISO date, currency, money,
              pagination) and enum schemas mirroring the platform's Prisma
              model enums (User, Booking, Itinerary, TravelPreferences,
              BookingAuditLog, Session). No database access — enum values
              are duplicated here deliberately as plain string literals.
  search/     FlightSearchRequest, HotelSearchRequest,
              CarRentalSearchRequest, and the unified Offer shape.
  booking/    PassengerInfo, CreateBookingRequest, BookingResponse,
              Itinerary.
  payment/    PaymentIntentRequest, PaymentIntentResponse.
  auth/       Register, login, refresh, logout, OAuth callback, auth
              response.
  user/       Profile, TravelPreferences.
  events/     BookingConfirmationEvent, BookingCancellationEvent,
              NotificationEvent — each requires a `correlationId`.
  errors/     Reserved for WO-002 (not implemented by this package).
```

Every domain module exposes a barrel `index.ts` that re-exports only its
public schemas, inferred types, and user-facing message constants — no
internal helpers leak out. The root `src/index.ts` re-exports every domain
barrel plus `common` as a namespace.

## The additive-change rule

Because every service and the web app resolve this package through the pnpm
workspace protocol, a change here can break every downstream target at once.
Changes must be **additive only** unless a breaking change is explicitly
coordinated across all consumers in the same release:

- Adding an optional field, a new enum member at the end, or a new schema is
  safe.
- Renaming or removing an existing field, tightening a previously-optional
  field to required, or removing an enum member is a breaking change and
  requires a major version bump plus coordinated updates in every consuming
  service.
- Never change a validation message's wording without checking for tests
  (in this package or downstream) that assert the exact string — several
  messages (e.g. the IATA code message) are contractual, not cosmetic
  (BR-11).

## Deriving types

Never hand-write a type that duplicates a schema's shape. Always derive it
with `z.infer`:

```ts
import { z } from "zod";
import { FlightSearchRequestSchema } from "@travel/contracts/search";

type FlightSearchRequest = z.infer<typeof FlightSearchRequestSchema>;
// (this exact type is also exported directly as `FlightSearchRequest`)
```

## Consuming the package

```ts
// Root barrel — everything
import { FlightSearchRequestSchema, OfferSchema } from "@travel/contracts";

// Or a domain subpath export — smaller import surface
import { FlightSearchRequestSchema } from "@travel/contracts/search";
```

Parse untrusted input at the service boundary, before any business logic or
Prisma call runs:

```ts
const result = FlightSearchRequestSchema.safeParse(req.body);
if (!result.success) {
  return res.status(400).json({ errors: result.error.issues });
}
```

## Design notes

- **Dates are strings on the wire.** Every date/datetime field accepts an
  ISO-8601 string (as produced by `Date.prototype.toISOString()`) and
  coerces to a `Date` via `isoDateString` (`src/common/primitives.ts`).
  `z.date()` is never used directly in a wire schema — a JSON payload has no
  native Date type, so a browser-serialized payload must validate without
  any manual transformation by the caller.
- **Cross-field date-order rules use `superRefine`** so the failing field
  path names the offending field (e.g. `checkOutDate`, not the whole
  object).
- **Schemas are declared at module scope**, not constructed per request, so
  Zod's schema compilation happens once at import time — this protects the
  8ms validation budget on the 180ms p95 cache-hit search path.
- **Unknown keys are rejected.** Every request/response/event object schema
  uses `.strict()`, so an inbound payload with unexpected extra keys fails
  validation rather than silently passing extra data through.
- **Illustrative offers can never be bookable.** `OfferSchema` structurally
  forbids `provenance === "ILLUSTRATIVE" && bookable === true`.

## Scripts

- `pnpm build` — emit declarations + JS to `dist/` (`tsc -p tsconfig.build.json`).
- `pnpm test` — run the Vitest suite (unit, round-trip, dependency-boundary).
- `pnpm typecheck` — strict `tsc --noEmit` over `src/` and `test/`.
- `pnpm lint` — ESLint, including the `no-explicit-any` boundary rule.
- `pnpm check:deps` — standalone dependency-boundary assertion (also run as
  part of `pnpm test`).

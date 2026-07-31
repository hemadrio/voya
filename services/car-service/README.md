# car-service

Car rental search service — RapidAPI car rental supplier adapter.

## Provider Decision

**Confirmed provider: RapidAPI car rental endpoint**

During epic exploration (WO-028) the reference system referenced a `PricelineAdapter` for car rental. After reviewing the Secrets Manager inventory, the provisioned credential is:

- `RAPIDAPI_KEY` — shared RapidAPI API key (same key used by `hotel-service`)
- `RAPIDAPI_CAR_HOST` — RapidAPI provider hostname for car rental search (e.g. `booking-com15.p.rapidapi.com`)

**Rationale for RapidAPI over Priceline:**

1. **Single credential set** — The `RAPIDAPI_KEY` already provisioned for hotel search is reused here, avoiding a second credential rotation policy and Secrets Manager rotation Lambda.
2. **Wildcard egress already approved** — `*.p.rapidapi.com` is in `ALLOWED_DESTINATIONS` (`packages/suppliers/src/egress/egressPolicy.ts`) with `allowWildcardSubdomains: true`. No new egress policy change is required.
3. **Consistent error taxonomy** — Both hotel and car adapters classify errors identically via `SupplierHttpClient`, giving uniform 422/502/504 upstream behaviour.
4. **No Priceline credential** — No Priceline credential exists in the current Secrets Manager inventory; provisioning one would require a separate onboarding agreement that is out of scope for the current sprint.

## Architecture

```
composition.ts  →  RapidApiCarAdapter (SupplierPort, INSTANT)
                        │
                        ├── SupplierHttpClient (2200ms timeout, 1 retry on 5xx)
                        │     └── EgressAllowList (RAPIDAPI_CAR_HOST + *.p.rapidapi.com SSRF)
                        └── rapidApiCarMapper
                              └── vehicleClassMap (token-based, data-driven, UNKNOWN fallback)
```

## Configuration

| Environment variable  | Secret? | Description                                           |
|-----------------------|---------|-------------------------------------------------------|
| `RAPIDAPI_KEY`        | Yes     | Shared RapidAPI API key (x-rapidapi-key header)       |
| `RAPIDAPI_CAR_HOST`   | Yes     | Provider hostname (x-rapidapi-host header)            |

Both must be non-empty and non-placeholder at startup (`assertSecretsOrExit`, WO-012).

## Running tests

```bash
cd services/car-service
npx vitest run
```

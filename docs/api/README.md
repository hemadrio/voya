# API Reference — Travel Platform v1

This directory contains the generated OpenAPI 3.1 specification for the travel platform's v1 REST API.

## Files

| File | Description |
|---|---|
| `openapi.yaml` | Generated OpenAPI 3.1 document (JSON format — valid YAML 1.2). **Never edit by hand.** |

## Regenerating the specification

```bash
# From the repository root
tsx scripts/generate-openapi.ts
```

The script writes to `docs/api/openapi.yaml`. Commit the updated file alongside any Zod schema change.

## Drift check

The pipeline runs `scripts/generate-openapi.ts` to a temporary file and fails if the output differs from the committed `openapi.yaml`. This means a schema change that is not reflected in the committed reference **fails the build**, preventing documentation drift.

To run the drift check locally:

```bash
tsx scripts/generate-openapi.ts --out /tmp/openapi-check.yaml
diff docs/api/openapi.yaml /tmp/openapi-check.yaml
```

A zero-exit `diff` means the committed file is current.

## Conventions

### Error envelope

Every 4xx and 5xx response uses the shared `ErrorEnvelope` component:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Airport code must be a valid 3-letter IATA code",
    "field": "origin"
  },
  "reference": "01j3h4k-7f2a9b"
}
```

The `reference` field equals the active **X-Ray trace identifier**. A traveler can screenshot this value and support can pivot directly from the screenshot to the trace in the X-Ray console, or to the log stream in CloudWatch Logs Insights using:

```
fields @timestamp, @message
| filter @requestId = "01j3h4k-7f2a9b"
| sort @timestamp asc
```

### Fixed status semantics

Every operation declares the full set of standard error responses. Status codes have fixed semantics:

| Status | Meaning |
|---|---|
| 400 | Zod schema validation failed; `error.field` names the offending field |
| 401 | Missing or invalid access token or session cookie |
| 403 | Authenticated user does not own this resource |
| 404 | Resource not found |
| 409 | Lifecycle conflict — the requested state transition is invalid from the current status |
| 422 | Supplier rejection — the upstream supplier rejected the booking or payment |
| 429 | Rate limited — see `Retry-After` response header |
| 502 | Supplier unavailable — upstream 5xx or unexpected response |
| 504 | Supplier timeout — upstream did not respond within the configured timeout |

**409 vs 422:** `409 LifecycleConflict` applies to platform-level state-machine violations (e.g., confirming an already-cancelled booking). `422 SupplierRejected` applies to supplier-level rejections (e.g., seat no longer available). These are distinct conditions and must not be conflated.

### Authentication

The specification declares two security schemes:

| Scheme | Type | Description |
|---|---|---|
| `bearerAccessToken` | HTTP Bearer | Short-lived RS256 JWT (15-minute TTL) |
| `sessionCookie` | Cookie | HttpOnly Secure SameSite=Strict cookie |

A global security requirement applies `bearerAccessToken OR sessionCookie` to every operation by default.

**Guest-allowed operations** explicitly clear the security requirement (`security: []`):
- `POST /v1/flights/search`
- `POST /v1/hotels/search`
- `POST /v1/cars/search`
- `POST /v1/chat`
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/google/callback`
- `POST /v1/payments/webhook` (Stripe HMAC-authenticated, not bearer)

### Stripe webhook

`POST /v1/payments/webhook` is mounted **before** the JSON body parser middleware. The request body must be the raw, unmodified byte stream for HMAC signature verification. The content type is `application/octet-stream` in the OpenAPI spec to document this requirement. Any proxy or middleware that parses or re-serialises the body before this route handler will invalidate the signature.

### Offer provenance

Search responses return offers with a `provenance` field: `AMADEUS`, `RAPIDAPI`, or `ILLUSTRATIVE`. Offers with `provenance=ILLUSTRATIVE` have `bookable=false` and will be rejected by the booking service. This is a structural property — `ProvenanceGuard` rejects the booking before writing any database row.

## Adding a new operation

1. Add the Zod request/response schemas to `packages/contracts/src/`.
2. Register the operation in `packages/contracts/src/openapi/registry.ts` with `operationId`, `method`, `path`, `tags`, `auth`, `requestBody`, and `successResponse`.
3. Run `tsx scripts/generate-openapi.ts` and commit the updated `docs/api/openapi.yaml`.
4. The pipeline drift check will verify the committed file matches the generated output.

#!/usr/bin/env npx tsx
/**
 * Generates docs/api/openapi.yaml deterministically from the Zod schemas
 * registered in packages/contracts/src/openapi/registry.ts.
 *
 * Output is JSON (which is valid YAML 1.2) with recursively sorted keys so
 * that diffs are meaningful and the drift-check step in the pipeline
 * produces a clean comparison.
 *
 * Usage:
 *   npx tsx scripts/generate-openapi.ts              # writes docs/api/openapi.yaml
 *   npx tsx scripts/generate-openapi.ts --out /tmp/openapi-check.yaml
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { OPERATIONS, ErrorEnvelopeSchema } from "../packages/contracts/src/openapi/registry.js";
import { zodToJsonSchema } from "../packages/contracts/src/openapi/zodToJsonSchema.js";
import type { OperationDef } from "../packages/contracts/src/openapi/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const outArg = process.argv.indexOf("--out");
const outPath =
  outArg !== -1 && process.argv[outArg + 1]
    ? resolve(process.argv[outArg + 1])
    : resolve(ROOT, "docs/api/openapi.yaml");

// ---------------------------------------------------------------------------
// Shared error response components
// ---------------------------------------------------------------------------

const ERROR_RESPONSES: Record<string, unknown> = {
  ValidationFailed: {
    description: "Request body or query parameters failed Zod schema validation",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorEnvelope" },
        example: {
          error: {
            code: "VALIDATION_FAILED",
            message: "Airport code must be a valid 3-letter IATA code",
            field: "origin",
          },
          reference: "01j3h4k-7f2a9b",
        },
      },
    },
  },
  Unauthenticated: {
    description: "Missing or invalid access token or session cookie",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  },
  Forbidden: {
    description: "Authenticated user does not own this resource",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  },
  NotFound: {
    description: "Resource not found",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  },
  LifecycleConflict: {
    description:
      "The requested state transition is not permitted from the current booking status",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  },
  SupplierRejected: {
    description:
      "The upstream supplier rejected the booking or payment — re-consent or retry required",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  },
  RateLimited: {
    description: "Too many requests — see Retry-After header",
    headers: {
      "Retry-After": {
        schema: { type: "integer" },
        description: "Seconds until the rate limit resets",
      },
    },
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  },
  SupplierUnavailable: {
    description: "Upstream supplier returned an unexpected error (5xx or timeout)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  },
  SupplierTimeout: {
    description: "Upstream supplier did not respond within the configured timeout",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  },
};

// ---------------------------------------------------------------------------
// Build OpenAPI document
// ---------------------------------------------------------------------------

function buildDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of OPERATIONS as OperationDef[]) {
    if (!paths[op.path]) paths[op.path] = {};

    const parameters: unknown[] = [];

    for (const p of op.pathParams ?? []) {
      parameters.push({
        description: p.description,
        in: "path",
        name: p.name,
        required: true,
        schema: p.schema,
      });
    }

    for (const q of op.queryParams ?? []) {
      parameters.push({
        description: q.description,
        in: "query",
        name: q.name,
        required: q.required,
        schema: q.schema,
      });
    }

    let requestBody: Record<string, unknown> | undefined;
    if (op.requestBody) {
      const contentType = op.requestBody.contentType ?? "application/json";
      const bodySchema = zodToJsonSchema(op.requestBody.schema);
      requestBody = {
        ...(op.requestBody.description ? { description: op.requestBody.description } : {}),
        content: { [contentType]: { schema: bodySchema } },
        required: op.requestBody.required,
      };
    }

    const successBody: Record<string, unknown> = {
      description: op.successResponse.description,
    };
    if (op.successResponse.schema) {
      const successSchema = op.successResponse.isArray
        ? { items: zodToJsonSchema(op.successResponse.schema), type: "array" }
        : zodToJsonSchema(op.successResponse.schema);
      successBody.content = { "application/json": { schema: successSchema } };
    }

    const responses: Record<string, unknown> = {
      [String(op.successResponse.statusCode)]: successBody,
      "400": { $ref: "#/components/responses/ValidationFailed" },
      "401": { $ref: "#/components/responses/Unauthenticated" },
      "403": { $ref: "#/components/responses/Forbidden" },
      "404": { $ref: "#/components/responses/NotFound" },
      "409": { $ref: "#/components/responses/LifecycleConflict" },
      "422": { $ref: "#/components/responses/SupplierRejected" },
      "429": { $ref: "#/components/responses/RateLimited" },
      "502": { $ref: "#/components/responses/SupplierUnavailable" },
      "504": { $ref: "#/components/responses/SupplierTimeout" },
    };

    const security: unknown[] = op.auth
      ? [{ bearerAccessToken: [] }, { sessionCookie: [] }]
      : [];

    const operation: Record<string, unknown> = {
      operationId: op.operationId,
      responses,
      security,
      summary: op.summary,
      tags: op.tags,
    };
    if (parameters.length > 0) operation.parameters = parameters;
    if (requestBody) operation.requestBody = requestBody;

    paths[op.path][op.method] = operation;
  }

  const errorEnvelopeSchema = zodToJsonSchema(ErrorEnvelopeSchema);

  return {
    components: {
      responses: ERROR_RESPONSES,
      schemas: {
        ErrorEnvelope: {
          ...errorEnvelopeSchema,
          description:
            "Platform-wide error envelope. The `reference` field equals the active X-Ray trace " +
            "identifier so a traveler screenshot resolves directly to a trace. " +
            "Present on all 4xx and 5xx responses.",
        },
      },
      securitySchemes: {
        bearerAccessToken: {
          bearerFormat: "JWT",
          description:
            "Short-lived RS256 JWT (15-minute TTL) issued by auth-service. " +
            "Claims: sub (userId), sid (sessionId), roles, jti.",
          scheme: "bearer",
          type: "http",
        },
        sessionCookie: {
          description:
            "HttpOnly Secure SameSite=Strict cookie. " +
            "Set by the gateway on login and rotated on every refresh.",
          in: "cookie",
          name: "session",
          type: "apiKey",
        },
      },
    },
    info: {
      description:
        "v1 REST API for the AI-powered multi-supplier travel booking platform. " +
        "All error responses carry a `reference` field equal to the active X-Ray trace identifier, " +
        "allowing support to pivot from a traveler screenshot to a trace. " +
        "The `error.code` field is an ErrorCode enum value defined in @travel/contracts/errors.",
      title: "Travel Platform v1 API",
      version: "1.0.0",
    },
    openapi: "3.1.0",
    paths,
    security: [{ bearerAccessToken: [] }, { sessionCookie: [] }],
    servers: [
      { description: "Production", url: "https://api.travel.example.com" },
      { description: "Local development (api-gateway)", url: "http://localhost:3000" },
    ],
    tags: [
      { description: "Authentication and session management", name: "auth" },
      { description: "Unified supplier search (guest-allowed)", name: "search" },
      { description: "Flight-specific search", name: "flights" },
      { description: "Hotel-specific search", name: "hotels" },
      { description: "Car rental search", name: "cars" },
      { description: "Traveler profile and preferences", name: "users" },
      { description: "Booking lifecycle (create, confirm, cancel)", name: "bookings" },
      { description: "Multi-leg itinerary management", name: "itineraries" },
      { description: "Stripe PaymentIntent and webhook handling", name: "payments" },
      { description: "AI conversational planning (guest-allowed)", name: "chat" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Deterministic JSON serialisation (stable key ordering)
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.keys(val as Record<string, unknown>)
          .sort()
          .reduce(
            (acc, k) => {
              acc[k] = (val as Record<string, unknown>)[k];
              return acc;
            },
            {} as Record<string, unknown>,
          );
      }
      return val;
    },
    2,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const doc = buildDocument();
const output = stableStringify(doc) + "\n";

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, output, "utf8");
console.log(`✓ OpenAPI spec written to ${outPath}`);

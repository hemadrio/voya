import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../zodToJsonSchema.js";

describe("zodToJsonSchema", () => {
  // ── Primitives ────────────────────────────────────────────────────────

  it("converts ZodString to {type:string}", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" });
  });

  it("converts ZodNumber to {type:number}", () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
  });

  it("converts ZodBoolean to {type:boolean}", () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" });
  });

  it("converts ZodDate to {type:string, format:date-time}", () => {
    expect(zodToJsonSchema(z.date())).toEqual({ type: "string", format: "date-time" });
  });

  // ── String checks ─────────────────────────────────────────────────────

  it("propagates minLength check", () => {
    const schema = z.string().min(3);
    expect(zodToJsonSchema(schema)).toMatchObject({ type: "string", minLength: 3 });
  });

  it("propagates email format", () => {
    const schema = z.string().email();
    expect(zodToJsonSchema(schema)).toMatchObject({ type: "string", format: "email" });
  });

  it("propagates uuid format", () => {
    const schema = z.string().uuid();
    expect(zodToJsonSchema(schema)).toMatchObject({ type: "string", format: "uuid" });
  });

  it("propagates regex pattern", () => {
    const schema = z.string().regex(/^[A-Z]{3}$/);
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ type: "string", pattern: "^[A-Z]{3}$" });
  });

  // ── Number checks ─────────────────────────────────────────────────────

  it("propagates minimum constraint (inclusive)", () => {
    const schema = z.number().min(1);
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ type: "number", minimum: 1 });
  });

  it("converts int check to type:integer", () => {
    const schema = z.number().int();
    expect(zodToJsonSchema(schema)).toMatchObject({ type: "integer" });
  });

  // ── Enums ─────────────────────────────────────────────────────────────

  it("converts ZodEnum to {type:string, enum:[...]}", () => {
    const schema = z.enum(["PENDING", "CONFIRMED", "CANCELLED"]);
    expect(zodToJsonSchema(schema)).toEqual({
      type: "string",
      enum: ["PENDING", "CONFIRMED", "CANCELLED"],
    });
  });

  // ── Literals ──────────────────────────────────────────────────────────

  it("converts ZodLiteral to {const:value}", () => {
    expect(zodToJsonSchema(z.literal("AMADEUS"))).toEqual({ const: "AMADEUS" });
  });

  // ── Arrays ────────────────────────────────────────────────────────────

  it("converts ZodArray to {type:array, items:...}", () => {
    const schema = z.array(z.string());
    expect(zodToJsonSchema(schema)).toEqual({ type: "array", items: { type: "string" } });
  });

  // ── Objects ───────────────────────────────────────────────────────────

  it("converts ZodObject with required and optional fields", () => {
    const schema = z
      .object({
        id: z.string(),
        name: z.string(),
        note: z.string().optional(),
      })
      .strict();

    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        note: { type: "string" },
      },
    });
    expect((result.required as string[]).sort()).toEqual(["id", "name"]);
    expect(result.additionalProperties).toBe(false);
  });

  it("converts nested ZodObject", () => {
    const inner = z.object({ code: z.string(), message: z.string() }).strict();
    const outer = z.object({ error: inner, reference: z.string() }).strict();
    const result = zodToJsonSchema(outer);
    expect(result).toMatchObject({
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: { code: { type: "string" }, message: { type: "string" } },
        },
        reference: { type: "string" },
      },
    });
  });

  // ── Unions ────────────────────────────────────────────────────────────

  it("converts ZodUnion to {oneOf:[...]}", () => {
    const schema = z.union([z.string(), z.number()]);
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ oneOf: [{ type: "string" }, { type: "number" }] });
  });

  // ── Optional / Nullable ───────────────────────────────────────────────

  it("unwraps ZodOptional to the inner schema", () => {
    const schema = z.string().optional();
    expect(zodToJsonSchema(schema)).toEqual({ type: "string" });
  });

  it("converts ZodNullable to oneOf with null", () => {
    const schema = z.string().nullable();
    expect(zodToJsonSchema(schema)).toMatchObject({ oneOf: [{ type: "string" }, { type: "null" }] });
  });

  // ── Effects (transform / superRefine) ─────────────────────────────────

  it("unwraps ZodEffects to the inner schema", () => {
    const schema = z.string().transform((v) => v.toUpperCase());
    expect(zodToJsonSchema(schema)).toMatchObject({ type: "string" });
  });

  it("unwraps ZodEffects with superRefine", () => {
    const schema = z
      .object({ a: z.number(), b: z.number() })
      .strict()
      .superRefine((data, ctx) => {
        if (data.a > data.b) ctx.addIssue({ code: "custom", message: "a must be <= b" });
      });
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ type: "object" });
  });

  // ── Pipeline ──────────────────────────────────────────────────────────

  it("uses the output schema of a ZodPipeline (IATA code pattern)", () => {
    // Mirrors how iataCode is constructed in @travel/contracts/common/primitives
    const iataCode = z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{3}$/, { message: "IATA code" }));
    const result = zodToJsonSchema(iataCode);
    // The output schema (z.string().regex()) carries the pattern
    expect(result).toMatchObject({ type: "string", pattern: "^[A-Z]{3}$" });
  });

  it("uses the output schema of a ZodPipeline (date-time)", () => {
    // Mirrors isoDateString
    const isoDateString = z.string().datetime({ offset: true }).pipe(z.coerce.date());
    const result = zodToJsonSchema(isoDateString);
    expect(result).toMatchObject({ type: "string", format: "date-time" });
  });

  // ── Currency / money (union with transform) ───────────────────────────

  it("converts positiveMoney-style schema (union) to oneOf", () => {
    const schema = z.union([z.string(), z.number()]).transform(() => 0);
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ oneOf: [{ type: "string" }, { type: "number" }] });
  });

  // ── Default ───────────────────────────────────────────────────────────

  it("converts ZodDefault and includes the default value", () => {
    const schema = z.number().int().default(1);
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ default: 1 });
  });

  // ── Generator determinism ─────────────────────────────────────────────

  it("produces identical output on two consecutive calls (determinism)", () => {
    const schema = z
      .object({
        id: z.string().uuid(),
        status: z.enum(["PENDING", "CONFIRMED"]),
        amount: z.number().positive(),
        tags: z.array(z.string()),
        meta: z.object({ note: z.string().optional() }).strict().optional(),
      })
      .strict();

    const first = JSON.stringify(zodToJsonSchema(schema));
    const second = JSON.stringify(zodToJsonSchema(schema));
    expect(first).toBe(second);
  });

  // ── Real contract schemas ──────────────────────────────────────────────

  it("converts FlightSearchRequestSchema without throwing", async () => {
    const { FlightSearchRequestSchema } = await import("../../search/flight.js");
    const result = zodToJsonSchema(FlightSearchRequestSchema);
    expect(result).toMatchObject({ type: "object" });
    expect(result.properties).toBeDefined();
  });

  it("converts AuthResponseSchema without throwing", async () => {
    const { AuthResponseSchema } = await import("../../auth/index.js");
    const result = zodToJsonSchema(AuthResponseSchema);
    expect(result).toMatchObject({ type: "object" });
  });

  it("converts BookingResponseSchema without throwing", async () => {
    const { BookingResponseSchema } = await import("../../booking/response.js");
    const result = zodToJsonSchema(BookingResponseSchema);
    expect(result).toMatchObject({ type: "object" });
    expect(result.properties).toBeDefined();
  });

  it("converts ErrorEnvelopeSchema and includes reference description context", async () => {
    const { ErrorEnvelopeSchema } = await import("../../errors/envelope.js");
    const result = zodToJsonSchema(ErrorEnvelopeSchema);
    expect(result).toMatchObject({ type: "object" });
    const props = result.properties as Record<string, unknown>;
    expect(props).toHaveProperty("reference");
    expect(props).toHaveProperty("error");
  });
});

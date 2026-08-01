/**
 * Zod validation schemas for checkout wizard steps (WO-068).
 *
 * Shared between client-side React Hook Form and server action parsing so
 * validation messages are identical on both sides of the wire.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const requiredString = (label: string) =>
  z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`);

const emailField = z
  .string({ required_error: "Email is required" })
  .trim()
  .toLowerCase()
  .email("Enter a valid email address");

const phoneField = z
  .string({ required_error: "Phone number is required" })
  .trim()
  .regex(/^\+?[0-9\s\-().]{7,20}$/, "Enter a valid phone number");

// ---------------------------------------------------------------------------
// Step 1: Traveler details
// ---------------------------------------------------------------------------

export const PrimaryTravelerSchema = z.object({
  firstName: requiredString("First name").max(64, "First name must be at most 64 characters"),
  lastName: requiredString("Last name").max(64, "Last name must be at most 64 characters"),
  email: emailField,
  phone: phoneField,
});

export type PrimaryTravelerValues = z.infer<typeof PrimaryTravelerSchema>;

export const GuestSchema = z.object({
  firstName: requiredString("First name").max(64),
  lastName: requiredString("Last name").max(64),
  age: z
    .number({ required_error: "Age is required" })
    .int("Age must be a whole number")
    .min(0, "Age must be 0 or older")
    .max(120, "Age must be realistic"),
});

export type GuestValues = z.infer<typeof GuestSchema>;

export const ConsentSchema = z.object({
  terms: z.literal(true, {
    errorMap: () => ({ message: "You must accept the terms and conditions" }),
  }),
  cancellationPolicy: z.literal(true, {
    errorMap: () => ({ message: "You must acknowledge the cancellation policy" }),
  }),
  marketing: z.boolean().default(false),
});

export type ConsentValues = z.infer<typeof ConsentSchema>;

export const TravelerDetailsSchema = z.object({
  primary: PrimaryTravelerSchema,
  guests: z.array(GuestSchema).default([]),
  specialRequests: z.string().max(500, "Special requests must be at most 500 characters").optional(),
  consents: ConsentSchema,
});

export type TravelerDetailsValues = z.infer<typeof TravelerDetailsSchema>;

// ---------------------------------------------------------------------------
// Step 2: Extras and promo code
// ---------------------------------------------------------------------------

export const ExtraItemSchema = z.object({
  code: z.string().min(1),
  quantity: z.number().int().min(0).max(10),
});

export type ExtraItemValues = z.infer<typeof ExtraItemSchema>;

export const PromoCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9\-_]{3,32}$/, "Enter a valid promo code")
    .optional()
    .or(z.literal("")),
});

export type PromoCodeValues = z.infer<typeof PromoCodeSchema>;

export const ExtrasSchema = z.object({
  extras: z.array(ExtraItemSchema).default([]),
  promoCode: z.string().trim().optional(),
});

export type ExtrasValues = z.infer<typeof ExtrasSchema>;

// ---------------------------------------------------------------------------
// Step 3: Review (price acknowledgement)
// ---------------------------------------------------------------------------

export const ReviewSchema = z.object({
  priceChangeAcknowledged: z.boolean().default(false),
  quoteId: z.string().min(1),
});

export type ReviewValues = z.infer<typeof ReviewSchema>;

// ---------------------------------------------------------------------------
// Step 4: Payment (no form values — handled by payment element)
// ---------------------------------------------------------------------------

export const PaymentSchema = z.object({
  paymentIntentId: z.string().min(1),
});

export type PaymentValues = z.infer<typeof PaymentSchema>;

// ---------------------------------------------------------------------------
// Checkout steps
// ---------------------------------------------------------------------------

export const CHECKOUT_STEPS = ["traveler", "extras", "review", "payment"] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];

export function isValidCheckoutStep(step: string): step is CheckoutStep {
  return (CHECKOUT_STEPS as readonly string[]).includes(step);
}

export function nextStep(current: CheckoutStep): CheckoutStep | null {
  const idx = CHECKOUT_STEPS.indexOf(current);
  return idx < CHECKOUT_STEPS.length - 1 ? CHECKOUT_STEPS[idx + 1] : null;
}

export function prevStep(current: CheckoutStep): CheckoutStep | null {
  const idx = CHECKOUT_STEPS.indexOf(current);
  return idx > 0 ? CHECKOUT_STEPS[idx - 1] : null;
}

export const STEP_LABELS: Record<CheckoutStep, string> = {
  traveler: "Your details",
  extras: "Extras",
  review: "Review",
  payment: "Payment",
};

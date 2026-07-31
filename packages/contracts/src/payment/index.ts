import { z } from "zod";
import { currencyCode, identifier, positiveMoney } from "../common/primitives.js";
import { PaymentStatusSchema } from "../common/enums.js";

/**
 * Requests a Stripe PaymentIntent for a `PENDING` booking. `idempotencyKey`
 * is forwarded to Stripe as the request idempotency key so a client retry
 * never creates a second charge.
 */
export const PaymentIntentRequestSchema = z
  .object({
    bookingId: identifier,
    amount: positiveMoney,
    currency: currencyCode,
    paymentMethodId: z.string().trim().min(1).optional(),
    idempotencyKey: identifier,
  })
  .strict();

export type PaymentIntentRequest = z.infer<typeof PaymentIntentRequestSchema>;

/**
 * `clientSecret` is the only value the browser needs to complete card entry
 * via Stripe-hosted fields; card data itself never crosses the platform
 * boundary. Final confirmation always comes from the signature-verified
 * webhook, never from this response.
 */
export const PaymentIntentResponseSchema = z
  .object({
    id: identifier,
    bookingId: identifier,
    clientSecret: z.string().trim().min(1),
    status: PaymentStatusSchema,
    amount: positiveMoney,
    currency: currencyCode,
  })
  .strict();

export type PaymentIntentResponse = z.infer<typeof PaymentIntentResponseSchema>;

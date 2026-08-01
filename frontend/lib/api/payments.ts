/**
 * Payments API client (WO-068, AC6).
 *
 * Creates payment intents tied to the quote and draft.
 * The clientSecret is returned to the client component that mounts the
 * payment provider element — it never touches server-side rendering.
 *
 * Constraint: raw card data must never touch application code or state.
 * Only the payment provider element (Stripe Elements or equivalent) may
 * collect and tokenize card details.
 */

import { apiClient } from "./client.js";

// ---------------------------------------------------------------------------
// Payment intent
// ---------------------------------------------------------------------------

export interface PaymentIntentResponse {
  paymentIntentId: string;
  /** Provider client secret — passed to the payment element, never logged. */
  clientSecret: string;
  /** True when 3-D Secure or equivalent action is required. */
  requiresAction: boolean;
  /** Supported payment methods (e.g. ["card", "ideal"]). */
  supportedMethods: string[];
}

export async function createPaymentIntent(
  quoteId: string,
  draftId: string,
  currency: string,
  signal?: AbortSignal,
): Promise<PaymentIntentResponse> {
  return apiClient.post<PaymentIntentResponse>(
    "/payments/intents",
    { quoteId, draftId, currency },
    { signal },
  );
}

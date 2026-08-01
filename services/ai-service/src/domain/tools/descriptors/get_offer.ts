import { GetOfferInputSchema, OfferLookupResultSchema } from "@travel/contracts";
import type { ToolDescriptor } from "../ToolDescriptor.js";

export function createGetOfferDescriptor(gatewayBaseUrl: string): ToolDescriptor {
  const url = new URL("/v1/offers", gatewayBaseUrl).href;

  return {
    name: "get_offer",
    description:
      "Look up a specific offer by its ID to retrieve full pricing and availability details. " +
      "Use this after a search to get the latest status on an offer before booking.",
    inputSchema: GetOfferInputSchema,
    outputSchema: OfferLookupResultSchema,
    pathTemplate: "/v1/offers",
    async resolver(input, ctx, http, { signal }) {
      const { offerId } = input as { offerId: string };
      const headers: Record<string, string> = {
        "x-correlation-id": ctx.correlationId,
      };
      if (ctx.authToken !== undefined) headers["Authorization"] = `Bearer ${ctx.authToken}`;

      const res = await http.get(`${url}?id=${encodeURIComponent(offerId)}`, { headers, signal });
      return res.json();
    },
  };
}

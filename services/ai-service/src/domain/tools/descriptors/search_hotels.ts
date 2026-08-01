import { HotelSearchRequestSchema } from "@travel/contracts";
import { z } from "zod";
import type { ToolDescriptor } from "../ToolDescriptor.js";

const OUTPUT_SCHEMA = z.array(z.record(z.string(), z.unknown()));

export function createSearchHotelsDescriptor(gatewayBaseUrl: string): ToolDescriptor {
  const url = new URL("/v1/search/hotels", gatewayBaseUrl).href;

  return {
    name: "search_hotels",
    description:
      "Search for hotels at a location. " +
      "Check-out date must be strictly after check-in date. " +
      "Results are ILLUSTRATIVE until a live search is completed.",
    inputSchema: HotelSearchRequestSchema,
    outputSchema: OUTPUT_SCHEMA,
    pathTemplate: "/v1/search/hotels",
    async resolver(input, ctx, http, { signal }) {
      const params = new URLSearchParams(
        Object.entries(input as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      );
      const headers: Record<string, string> = {
        "x-correlation-id": ctx.correlationId,
      };
      if (ctx.authToken !== undefined) headers["Authorization"] = `Bearer ${ctx.authToken}`;

      const res = await http.get(`${url}?${params.toString()}`, { headers, signal });
      return res.json();
    },
  };
}

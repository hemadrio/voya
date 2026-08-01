import { FlightSearchRequestSchema } from "@travel/contracts";
import { z } from "zod";
import type { ToolDescriptor } from "../ToolDescriptor.js";

const OUTPUT_SCHEMA = z.array(z.record(z.string(), z.unknown()));

export function createSearchFlightsDescriptor(gatewayBaseUrl: string): ToolDescriptor {
  const url = new URL("/v1/search/flights", gatewayBaseUrl).href;

  return {
    name: "search_flights",
    description:
      "Search for available flights between two airports. " +
      "Airport codes must be valid 3-letter IATA codes. " +
      "Departure date must be in the future. " +
      "Results are ILLUSTRATIVE until a live search is completed.",
    inputSchema: FlightSearchRequestSchema,
    outputSchema: OUTPUT_SCHEMA,
    pathTemplate: "/v1/search/flights",
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

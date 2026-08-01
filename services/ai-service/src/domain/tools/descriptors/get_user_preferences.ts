import { GetUserPreferencesInputSchema, UserPreferencesResultSchema } from "@travel/contracts";
import type { UserPreferencesResult } from "@travel/contracts";
import type { ToolDescriptor } from "../ToolDescriptor.js";

const EMPTY_PREFERENCES: UserPreferencesResult = {
  seatClass: undefined,
  dietaryRestrictions: [],
  roomPreferences: [],
};

export function createGetUserPreferencesDescriptor(gatewayBaseUrl: string): ToolDescriptor {
  const url = new URL("/v1/users/preferences", gatewayBaseUrl).href;

  return {
    name: "get_user_preferences",
    description:
      "Retrieve the authenticated user's saved travel preferences such as seat class, " +
      "dietary restrictions, and room preferences. Returns empty preferences for guest sessions.",
    inputSchema: GetUserPreferencesInputSchema,
    outputSchema: UserPreferencesResultSchema,
    pathTemplate: "/v1/users/preferences",
    async resolver(_input, ctx, http, { signal }) {
      // Guest (unauthenticated) path: return empty preferences without network call.
      if (ctx.userId === null) {
        return EMPTY_PREFERENCES;
      }

      const headers: Record<string, string> = {
        "x-correlation-id": ctx.correlationId,
      };
      // userId comes from JWT claim (server-controlled), not from model-supplied input.
      if (ctx.authToken !== undefined) headers["Authorization"] = `Bearer ${ctx.authToken}`;

      const res = await http.get(
        `${url}?userId=${encodeURIComponent(ctx.userId)}`,
        { headers, signal },
      );
      return res.json();
    },
  };
}

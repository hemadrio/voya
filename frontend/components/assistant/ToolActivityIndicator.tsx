/**
 * ToolActivityIndicator — shows tool progress as human-readable text (WO-062 AC2).
 *
 * Maps registered tool names to friendly labels.
 * Displays running/resolved/failed states with accessible status roles.
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/utils.js";
import type { ToolActivityState } from "@/lib/assistant/chatReducer.js";

// ---------------------------------------------------------------------------
// Tool name → human-readable label mapping
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  search_flights: "Searching flights",
  search_hotels: "Searching hotels",
  search_cars: "Searching rental cars",
  get_flight_details: "Loading flight details",
  get_hotel_details: "Loading hotel details",
  check_availability: "Checking availability",
  get_preferences: "Loading your preferences",
  price_check: "Verifying price",
};

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? `Running ${tool.replace(/_/g, " ")}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ToolActivityIndicatorProps {
  activity: ToolActivityState;
}

export function ToolActivityIndicator({ activity }: ToolActivityIndicatorProps): React.ReactElement {
  const { tool, status, summary } = activity;
  const label = toolLabel(tool);

  const summaryText =
    typeof summary === "string"
      ? summary
      : typeof summary === "object" && summary !== null && "message" in summary
        ? String((summary as Record<string, unknown>)["message"])
        : undefined;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-lg text-xs",
        status === "running" && "bg-neutral-100 text-neutral-600",
        status === "success" && "bg-green-50 text-green-700",
        status === "failure" && "bg-red-50 text-red-700",
      )}
      role="status"
      aria-label={`${label}: ${status}`}
    >
      {/* Status icon */}
      {status === "running" && (
        <span
          className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin flex-shrink-0"
          aria-hidden="true"
        />
      )}
      {status === "success" && (
        <span className="flex-shrink-0 text-green-600" aria-hidden="true">✓</span>
      )}
      {status === "failure" && (
        <span className="flex-shrink-0 text-red-500" aria-hidden="true">✗</span>
      )}

      <span className="font-medium">{label}</span>
      {summaryText && (
        <span className="text-current opacity-70 truncate">— {summaryText}</span>
      )}
    </div>
  );
}

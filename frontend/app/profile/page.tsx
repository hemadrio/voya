/**
 * Profile page — App Router Server Component.
 *
 * All user and preference types are imported from @travel/contracts.
 * No local shape is declared for any platform payload.
 */

import type { Profile, TravelPreferences } from "@travel/contracts/user";
import type { ApiResult } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ProfilePageProps {
  /** injected by Next.js from session context (WO auth middleware) */
  userId: string;
}

// ---------------------------------------------------------------------------
// Profile data helpers
// ---------------------------------------------------------------------------

/**
 * Build the display name from a Profile.
 * Pure function — safe to call in tests without a React environment.
 */
export function getDisplayName(profile: Profile): string {
  return `${profile.firstName} ${profile.lastName}`;
}

/**
 * Derive whether a user has completed travel preferences.
 * Used to prompt the onboarding flow in the profile page.
 */
export function hasCompletedPreferences(prefs: TravelPreferences): boolean {
  return (
    prefs.preferredSeatClass !== undefined ||
    prefs.preferredCurrency !== undefined ||
    (prefs.preferredAirlines !== undefined && prefs.preferredAirlines.length > 0)
  );
}

/**
 * Build a display-safe preferences summary.
 * Returns an array of human-readable key-value strings.
 */
export function summarisePreferences(prefs: TravelPreferences): string[] {
  const lines: string[] = [];
  if (prefs.preferredSeatClass !== undefined) {
    lines.push(`Seat class: ${prefs.preferredSeatClass}`);
  }
  if (prefs.preferredCurrency !== undefined) {
    lines.push(`Currency: ${prefs.preferredCurrency}`);
  }
  if (prefs.preferredAirlines !== undefined && prefs.preferredAirlines.length > 0) {
    lines.push(`Airlines: ${prefs.preferredAirlines.join(", ")}`);
  }
  if (
    prefs.dietaryRestrictions !== undefined &&
    prefs.dietaryRestrictions.length > 0
  ) {
    lines.push(`Dietary: ${prefs.dietaryRestrictions.join(", ")}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function ProfilePage() {
  // Full profile fetching and preferences form in subsequent WOs.
  return (
    <main>
      <h1>Profile</h1>
      <p>Profile page — full implementation in WO-007.</p>
    </main>
  );
}

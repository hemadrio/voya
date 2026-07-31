/**
 * alternativeDates — deterministic alternative departure date computation.
 *
 * Used in the empty-state response path when no supplier returns availability.
 * Produces a symmetric range of dates around the requested departure date.
 *
 * Constraints (from WO-034):
 *  - No additional supplier calls may be made for alternative dates.
 *  - Computation is purely deterministic (no I/O, no randomness).
 *  - Past dates are filtered out so the UI never shows a date that has expired.
 */

/**
 * Compute a sorted list of ISO-8601 date strings symmetrically offset around
 * `departureDateStr`, excluding the departure date itself and any past dates.
 *
 * @param departureDateStr  ISO-8601 date string (YYYY-MM-DD).
 * @param offsetDays        Symmetric window size. Defaults to 3 (−3 to +3).
 * @param nowMs             Current time in milliseconds; defaults to Date.now().
 * @returns Array of YYYY-MM-DD strings, sorted ascending, never including the
 *          original departure date.
 */
export function computeAlternativeDates(
  departureDateStr: string,
  offsetDays = 3,
  nowMs: number = Date.now(),
): string[] {
  const departureParts = departureDateStr.split('-');
  if (departureParts.length !== 3) return [];

  const departureMs = Date.parse(departureDateStr);
  if (isNaN(departureMs)) return [];

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const todayStartMs = new Date(nowMs).setUTCHours(0, 0, 0, 0);

  const results: string[] = [];

  for (let offset = -offsetDays; offset <= offsetDays; offset++) {
    if (offset === 0) continue; // skip the original departure date

    const candidateMs = departureMs + offset * ONE_DAY_MS;
    if (candidateMs <= todayStartMs) continue; // skip past dates

    const d = new Date(candidateMs);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    results.push(`${yyyy}-${mm}-${dd}`);
  }

  return results.sort();
}

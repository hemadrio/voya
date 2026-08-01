/**
 * ICS calendar file generation (WO-069, AC7).
 *
 * Produces a VEVENT with DTSTART and DTEND in the listing timezone.
 * The UID is derived from the booking reference for stability across re-downloads.
 *
 * Output format follows RFC 5545 (iCalendar).
 */

// ---------------------------------------------------------------------------
// ICS event input
// ---------------------------------------------------------------------------

export interface IcsEventInput {
  reference: string;     // Booking reference — used as UID base
  title: string;         // Summary / listing title
  checkIn: string;       // ISO date YYYY-MM-DD
  checkOut: string;      // ISO date YYYY-MM-DD
  timezone: string;      // IANA timezone string
  location?: string;     // Optional listing location label
  description?: string;  // Optional plain-text description
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function foldLine(line: string): string {
  // RFC 5545 §3.1: lines longer than 75 octets MUST be folded
  const limit = 75;
  if (line.length <= limit) return line;
  let result = "";
  let offset = 0;
  while (offset < line.length) {
    if (offset === 0) {
      result += line.slice(0, limit) + "\r\n";
      offset = limit;
    } else {
      result += " " + line.slice(offset, offset + limit - 1) + "\r\n";
      offset += limit - 1;
    }
  }
  return result.replace(/\r\n$/, ""); // trim trailing CRLF — caller adds it
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function nowUtcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "") + "Z";
}

// ---------------------------------------------------------------------------
// ICS generator
// ---------------------------------------------------------------------------

/**
 * Generate an iCalendar string for a single booking event.
 * DTSTART and DTEND are expressed as DATE values (all-day events) in the
 * listing timezone so calendar applications display the stay correctly
 * regardless of the viewer's local timezone.
 */
export function generateIcs(event: IcsEventInput): string {
  const uid = `booking-${event.reference}@voya.travel`;
  const dtstamp = nowUtcStamp();

  // All-day dates: VALUE=DATE, format YYYYMMDD
  const dtstart = event.checkIn.replace(/-/g, "");
  // DTEND for all-day events is the exclusive end → checkout date
  const dtend = event.checkOut.replace(/-/g, "");

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Voya Travel//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${dtstart}`,
    `DTEND;VALUE=DATE:${dtend}`,
    `SUMMARY:${escapeText(event.title)}`,
  ];

  if (event.location) {
    lines.push(`LOCATION:${escapeText(event.location)}`);
  }

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }

  // Add timezone as X property for informational purposes
  lines.push(`X-WR-TIMEZONE:${event.timezone}`);

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  // Fold each line and join with CRLF
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * Trigger a browser download of the generated ICS content.
 * Uses a temporary object URL to avoid server round-trips.
 */
export function downloadIcs(event: IcsEventInput, filename?: string): void {
  const content = generateIcs(event);
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename ?? `booking-${event.reference}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke after a tick to allow the download to start
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

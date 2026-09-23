import type { ExpiryFeedEntry } from "@saas/db/expiry";
import { expiryItemPublicId } from "./ids.js";
import { shiftDate } from "./ladder.js";

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold a content line at 75 octets (RFC 5545 §3.1), continuation lines start with a space. */
export function foldIcsLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (currentBytes + size > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function dateValue(iso: string): string {
  return iso.replace(/-/g, "");
}

/**
 * The calendar a subscriber sees: one all-day VEVENT per upcoming expiry.
 * Name, kind and date only — never the licence number, never an email address.
 */
export function renderIcs(calendarName: string, entries: ExpiryFeedEntry[], now: Date): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Expirio//Expiry feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of entries) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${expiryItemPublicId(e.id)}-${dateValue(e.expiresOn)}@expirio`,
      `DTSTAMP:${stamp(now)}`,
      `LAST-MODIFIED:${stamp(e.updatedAt)}`,
      `DTSTART;VALUE=DATE:${dateValue(e.expiresOn)}`,
      `DTEND;VALUE=DATE:${dateValue(shiftDate(e.expiresOn, 1))}`,
      `SUMMARY:${escapeIcsText(`Expires: ${e.name}`)}`,
      `CATEGORIES:${escapeIcsText(e.kind)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

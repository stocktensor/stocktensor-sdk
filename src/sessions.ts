import type { Session } from "./types.js";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/**
 * US equity session for a unix timestamp (US/Eastern, holidays not modelled),
 * the same rule as the subnet's `sessions.py`. Robinhood Chain stock token feeds
 * update 24/5 and hold their last price while the session is `closed`.
 */
export function sessionAt(unix: number): Session {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(unix * 1000)).map((p) => [p.type, p.value]));
  const weekday = WEEKDAYS[parts.weekday!]!;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (weekday === 5 || (weekday === 4 && minutes >= 20 * 60) || (weekday === 6 && minutes < 20 * 60)) return "closed";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "post";
  return "overnight";
}

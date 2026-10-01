/**
 * Dates, before they go stale.
 *
 * "Interview on Thursday" is true for a week and then quietly wrong: recalled
 * a month later it reads as an interview that is still coming. The fix is to
 * pin relative dates to the calendar at the moment they are said, in the text
 * that gets stored — "on Thursday (2 Oct 2026)" — so the memory carries the
 * date and the model, told what today is, can tell past from future.
 *
 * Deterministic on purpose. A model could do this, but this runs on every
 * message that gets written, and a rule that handles the common cases is
 * cheaper and never hallucinates a year.
 */

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

// Written by hand: en-GB's short month is "Sept", which nothing else parses.
const cap = (m) => m[0].toUpperCase() + m.slice(1);
const fmt = (d) => `${d.getDate()} ${cap(SHORT[d.getMonth()])} ${d.getFullYear()}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** "Today is Saturday 27 September 2026." — for the model, which has no clock. */
export function todayLine(now = new Date()) {
  return `Today is ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`;
}

/**
 * Pin the relative dates in a sentence to absolute ones, in brackets after
 * the phrase, leaving the person's words exactly as they were. Idempotent:
 * a phrase already followed by a bracketed date is left alone.
 */
export function resolveDates(text, now = new Date()) {
  const today = startOfDay(now);
  let out = String(text);

  const pin = (re, toDate) => {
    out = out.replace(re, (m, ...groups) => {
      const rest = groups[groups.length - 1]; // the whole string, for lookahead
      const offset = groups[groups.length - 2];
      if (/^\s*\(\d{1,2} \w{3,9} \d{4}\)/.test(rest.slice(offset + m.length))) return m; // already pinned
      const d = toDate(m, groups);
      return d ? `${m} (${fmt(d)})` : m;
    });
  };

  // today / tomorrow / yesterday / the day after tomorrow
  pin(/\b(the day after tomorrow)\b/gi, () => addDays(today, 2));
  pin(/\b(tomorrow)\b/gi, () => addDays(today, 1));
  pin(/\b(yesterday)\b/gi, () => addDays(today, -1));

  // in N days / in N weeks
  pin(/\bin (\d{1,2}) (days?|weeks?)\b/gi, (m, [n, unit]) => addDays(today, Number(n) * (/week/i.test(unit) ? 7 : 1)));

  // next week / next month (pinned to the Monday / the 1st)
  pin(/\bnext week\b/gi, () => { const d = addDays(today, 7); return addDays(d, ((1 - d.getDay()) + 7) % 7 - (d.getDay() === 0 ? 7 : 0)); });
  pin(/\bnext month\b/gi, () => new Date(today.getFullYear(), today.getMonth() + 1, 1));

  // (this|next|on|last) <weekday>, or a bare weekday. "Next Thursday" is the
  // one after this coming Thursday when today is within a couple of days of
  // it; the common reading, and the safe one is "the coming one".
  pin(/\b(?:(this|next|last|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, (m, [qual, day]) => {
    const target = DAYS.indexOf(day.toLowerCase());
    const delta = (target - today.getDay() + 7) % 7;
    const q = (qual ?? "").toLowerCase();
    if (q === "last") return addDays(today, delta === 0 ? -7 : delta - 7);
    if (q === "next") return addDays(today, delta === 0 ? 7 : delta + (delta <= 2 ? 7 : 0));
    return addDays(today, delta === 0 ? 7 : delta); // "on Thursday" said on a Thursday means next week's
  });

  // "3 November", "November 3", "Nov 3rd", "3rd of Nov" — a date with no year
  // gets the next occurrence; the year, if given, is respected by skipping.
  const monthRe = `(${[...MONTHS, ...SHORT].join("|")})`;
  const withYear = (m, month, dayNum) => {
    const mi = MONTHS.findIndex((x) => x.startsWith(month.toLowerCase().slice(0, 3)));
    let d = new Date(today.getFullYear(), mi, Number(dayNum));
    if (Number.isNaN(d.getTime()) || Number(dayNum) < 1 || Number(dayNum) > 31) return null;
    if (d < addDays(today, -60)) d = new Date(today.getFullYear() + 1, mi, Number(dayNum)); // long past → next year
    return d;
  };
  pin(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${monthRe}\\b(?![^()]*\\d{4})`, "gi"), (m, [dayNum, month]) => withYear(m, month, dayNum));
  pin(new RegExp(`\\b${monthRe}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b(?!,? ?\\d{4})`, "gi"), (m, [month, dayNum]) => withYear(m, month, dayNum));

  return out;
}

/**
 * Every absolute date in a memory, as written by resolveDates or by hand:
 * "2 Oct 2026", "2 October 2026", "Oct 2, 2026", "2026-10-02".
 */
export function datesIn(text) {
  const found = [];
  const s = String(text);
  const monthRe = `(${[...MONTHS, ...SHORT].join("|")})`;
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${monthRe}\\.?,? (\\d{4})\\b`, "gi"))) {
    found.push(toDate(m[2], m[1], m[3]));
  }
  for (const m of s.matchAll(new RegExp(`\\b${monthRe}\\.? (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b`, "gi"))) {
    found.push(toDate(m[1], m[2], m[3]));
  }
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    found.push(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  return found.filter((d) => d && !Number.isNaN(d.getTime()));
}

function toDate(month, day, year) {
  const mi = MONTHS.findIndex((x) => x.startsWith(month.toLowerCase().slice(0, 3)));
  return mi < 0 ? null : new Date(Number(year), mi, Number(day));
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export const daysBetween = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);

/**
 * Asking about the thing that was on Thursday.
 *
 * A memory of a plan is only useful twice: before it happens and once after.
 * The second one is the part people notice — "how did the interview go?" is
 * the moment a bot that stores facts turns into one that remembers you. So
 * each turn looks at the dated memories already in context, finds any whose
 * date has just passed, and hands the model one to ask about. Once.
 *
 * "Once" is the whole design. Asking about the same interview every message
 * would be worse than never asking, so every follow-up that reaches the model
 * is recorded here, on disk, beside the outbox. The record is small and it is
 * fine to lose: the worst case after a fresh volume is one repeated question.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { FILE as OUTBOX_FILE } from "./outbox.mjs";
import { datesIn, daysBetween } from "./time.mjs";

export const FILE = process.env.FOLLOWUPS_PATH ?? join(dirname(OUTBOX_FILE), "followups.json");

/** { asked: { [personId]: { [factHash]: isoDate } }, seen: { [personId]: "YYYY-MM-DD" } } */
let state = { asked: {}, seen: {} };
try { state = { asked: {}, seen: {}, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch { /* first run */ }

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state));
  } catch (err) {
    console.warn("[followups] could not save:", err.message);
  }
}

const key = (text) => createHash("sha1").update(String(text)).digest("hex").slice(0, 16);
const dayStamp = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Is this the person's first message today? Marks the day as seen either way.
 * The first message of a day is when a follow-up reads as natural, and it is
 * when the one extra recall for dated plans is worth its cost.
 */
export function firstTurnToday(personId, now = new Date()) {
  const today = dayStamp(now);
  const first = state.seen[personId] !== today;
  if (first) { state.seen[personId] = today; save(); }
  return first;
}

/* Memories that describe a plan rather than a fact about the past. A date on
   its own is not enough: "born 3 March 1994" has one too. */
export const PLAN = /\b(interview|appointment|meeting|call|exam|test|trip|flight|travel|visit|deadline|due|launch|demo|presentation|wedding|birthday|party|dinner|date|match|game|concert|gig|conference|surgery|dentist|doctor|move|moving|start(?:s|ing)?|deliver|submit|submission|pitch|review|viewing|holiday|vacation)\b/i;

/**
 * From memories already in hand, pick what to follow up on.
 *
 * Returns `{ past, upcoming }`: at most one plan whose date passed in the last
 * ten days and has not been asked about, and at most one within the next two
 * days. Nothing is marked as asked here — call `markAsked` once the model has
 * actually been given it, so a turn that fails does not burn the question.
 */
export function pickFollowUps(personId, facts, now = new Date()) {
  const asked = state.asked[personId] ?? {};
  let past = null, upcoming = null;

  for (const f of facts) {
    const text = String(f.text ?? f);
    if (!PLAN.test(text)) continue;
    for (const d of datesIn(text)) {
      const ago = daysBetween(d, now); // positive: already happened
      if (ago >= 1 && ago <= 10 && !asked[key(text)]) {
        if (!past || ago < past.daysAgo) past = { text, date: d, daysAgo: ago };
      } else if (ago <= 0 && ago >= -2) {
        if (!upcoming || -ago < upcoming.daysAhead) upcoming = { text, date: d, daysAhead: -ago };
      }
    }
  }
  return { past, upcoming };
}

export function markAsked(personId, text, now = new Date()) {
  state.asked[personId] ??= {};
  state.asked[personId][key(text)] = now.toISOString();
  // Keep the file from growing forever: forget what was asked over 90 days ago.
  const cutoff = now.getTime() - 90 * 86_400_000;
  for (const [k, iso] of Object.entries(state.asked[personId])) {
    if (Date.parse(iso) < cutoff) delete state.asked[personId][k];
  }
  save();
}

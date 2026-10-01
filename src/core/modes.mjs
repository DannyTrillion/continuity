/**
 * The job it is doing, without changing what it knows.
 *
 * A mode is a lens, not a second assistant. Tutor and coding partner read the
 * same memories, write to the same namespace and answer as the same person:
 * what changes is the manner — whether it teaches a thing or just fixes it.
 * That distinction is the whole product. A mode that also partitioned memory
 * would turn one assistant that knows you into four that each know a quarter,
 * which is the thing this was built to avoid.
 *
 * WHY IT IS STORED, AND WHERE
 *
 * In a namespace of its own, superseded on change, like the opt-out. That
 * makes it a memory rather than a session setting, so choosing Tutor on
 * Telegram is choosing it on Discord and the web — the cross-app claim, made
 * visible in one tap rather than described. Cached per person so the read
 * happens once a process rather than once a turn.
 */

import { readLatest } from "./memory.mjs";
import { enqueueRemember } from "./outbox.mjs";

export const modeNs = (personId) => `ws8::mode::${personId}`;

/**
 * Every overlay is about manner. None of them grants knowledge, relaxes the
 * trust boundary or changes who the assistant is — those live in the system
 * prompt and a mode is appended after it, never in place of it.
 */
export const MODES = {
  tutor: {
    label: "Tutor",
    blurb: "Teaches in steps and remembers where you got stuck",
    system:
      "YOU ARE TEACHING. Work in small steps and check each one has landed before the next. " +
      "Ask what they already know before explaining from the beginning. When they have asked to " +
      "learn something, do not hand over the finished answer — give the next step and let them " +
      "take it. When they get something wrong, say what is wrong and why, then let them try " +
      "again. If you remember where they stopped last time, start there.",
  },
  coding: {
    label: "Coding partner",
    blurb: "Code first, in the stack it already knows you use",
    system:
      "YOU ARE PAIRING ON CODE. Code first, words after. Use the tools and versions you already " +
      "know they work with and never ask them to repeat their setup. Give one runnable fix rather " +
      "than a survey of approaches, and name the file and line where you can. If an error is in " +
      "front of you, read it back exactly and say what it means before fixing it. Short sentences.",
  },
  planner: {
    label: "Planner",
    blurb: "Deals in dates, and asks how it went",
    system:
      "YOU ARE PLANNING. Deal in dates and next actions. Pin anything vague to a real date and say " +
      "that date back to them. Finish with the single next thing to do, not a list of options. If " +
      "something you remember was due and has passed, ask how it went before planning around it.",
  },
  support: {
    label: "Support desk",
    blurb: "Diagnoses first, and never asks twice",
    system:
      "YOU ARE ON A SUPPORT DESK. Diagnose before you fix. Ask what they have already tried — once, " +
      "and never again. Use what you already know about their setup instead of asking for it. Where " +
      "the knowledge base covers it, follow the knowledge base. If you do not know, say so plainly " +
      "and say what would tell you.",
  },
};

export const isMode = (id) => Object.hasOwn(MODES, String(id ?? ""));

/* One read per person per process, like the opt-out. A mode is consulted on
   every single turn, and a relayer round trip for it would cost more than the
   feature is worth. */
const cache = new Map(); // personId -> mode id or null

/** Which mode this person is in, or null for none. */
export async function modeFor(personId) {
  if (cache.has(personId)) return cache.get(personId);
  let id = null;
  try {
    const rec = await readLatest(modeNs(personId));
    const parsed = rec ? JSON.parse(rec.text ?? rec) : null;
    if (isMode(parsed?.mode)) id = parsed.mode;
  } catch {
    // Unreadable is not the same as unset, but for one turn it looks the
    // same and the cost of guessing wrong is a plainer answer. Not cached,
    // so the next turn asks again.
    return null;
  }
  cache.set(personId, id);
  return id;
}

/** Choose a mode, or pass null to go back to no mode at all. */
export function setMode(personId, id) {
  const mode = isMode(id) ? id : null;
  cache.set(personId, mode);
  enqueueRemember(modeNs(personId), JSON.stringify({ mode, at: new Date().toISOString() }), {
    label: `mode ${mode ?? "none"}`,
    idempotencyKey: `mode:${personId}:${mode ?? "none"}:${Date.now()}`,
  });
  return mode;
}

/* What a message is asking for, when it asks clearly.
   Keyword tests rather than a model call: this runs on every turn, and the
   cost of being wrong is one declined suggestion. */
const SIGNALS = [
  ["tutor", /\b(teach me|explain .{0,24}\b(to me|like i'm|from scratch)|how does .{3,40} work|help me (understand|learn)|i don'?t (get|understand)|walk me through|what even is)\b/i],
  ["coding", /\b(stack trace|typeerror|referenceerror|syntaxerror|err_[a-z_]+|exit code|npm err|build (is )?fail|won'?t compile|segfault|undefined is not|cannot read propert)\b|```/i],
  ["planner", /\b(help me (plan|prepare)|make me a plan|my (week|schedule)|deadline|due (on|by)|itinerary|prepare for (my|the)|what should i do (before|by))\b/i],
  ["support", /\b(not working|doesn'?t work|isn'?t working|broken|keeps failing|i get a (\d{3}|error)|403|404|500|502|how do i fix)\b/i],
];

/* Asked at most this often, so a decline is respected for a while. */
const QUIET_MS = 20 * 60 * 1000;
const offered = new Map(); // personId -> when

/**
 * A mode worth offering, or null.
 *
 * Only ever offered to someone who has not chosen one. Once a person has
 * picked, being nudged towards something else is second-guessing them, and
 * this is meant to help people who do not know the feature exists.
 */
export function suggestMode(personId, message, current, now = Date.now()) {
  if (current) return null;
  if (now - (offered.get(personId) ?? 0) < QUIET_MS) return null;
  const hit = SIGNALS.find(([, re]) => re.test(String(message ?? "")));
  if (!hit) return null;
  offered.set(personId, now);
  return hit[0];
}

/** Forget that anything was offered — for tests, and for a fresh start. */
export const forgetOffers = () => offered.clear();

/* ────────────────────────────────────────────────────────────────────────
   What each mode has to show for itself.

   These are views over the same memory, written once and read by two
   callers: the slash command on Telegram and Discord, and the /modes page
   on the web. Keeping them here rather than in either caller is what stops
   the bot and the page disagreeing about what the assistant knows — which
   is exactly the contradiction that made the memory dashboard sit beside a
   reply claiming to know nothing.
   ──────────────────────────────────────────────────────────────────────── */

import { recall, personNs } from "./memory.mjs";
import { PLAN } from "./followups.mjs";
import { datesIn, daysBetween } from "./time.mjs";

const nsOf = (person) => person.namespaces?.[0] ?? personNs(person.personId);

/**
 * Anything with a date on it, sorted, with how far away it is.
 *
 * `away` is in days: positive ahead, negative behind. Only the recent past
 * is kept — a deadline from March is not news, and a list that never shrinks
 * stops being read.
 */
export async function planItems(person, { lookBack = 14 } = {}) {
  const facts = await recall(
    nsOf(person),
    "plans, appointments, interviews, trips, deadlines and events on a date",
    { limit: 12, maxTokens: 900 },
  ).catch(() => []);

  const now = new Date();
  const out = [];
  for (const f of facts) {
    const text = String(f.text ?? "");
    if (!PLAN.test(text)) continue;
    for (const d of datesIn(text)) {
      const away = -daysBetween(d, now);
      if (away < -lookBack) continue;
      out.push({
        // The bracketed date is machinery the resolver added on the way in.
        text: text.replace(/\s*\([^)]*\d{4}\)/g, "").replace(/\s+/g, " ").trim(),
        date: d.toISOString(),
        away,
        blobId: f.blob_id ?? null,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/** How far away, in words a person would use. */
export const awayInWords = (away) =>
  away === 0 ? "today"
    : away === 1 ? "tomorrow"
      : away > 0 ? `in ${away} days`
        : away === -1 ? "yesterday"
          : `${-away} days ago`;

/**
 * What it knows about the tools someone works with.
 *
 * "Never ask them to repeat their setup" is a promise nobody can check until
 * it fails, so this is the check. Filtered to sentences that actually assert
 * something about usage rather than every fact that mentions a language.
 */
export async function stackItems(person, { limit = 8 } = {}) {
  const facts = await recall(
    nsOf(person),
    "the tools, languages, runtimes, editors, operating system and versions this person works with",
    { limit: 10, maxTokens: 700 },
  ).catch(() => []);

  return facts
    .map((f) => ({ text: String(f.text ?? "").replace(/\s+/g, " ").trim(), blobId: f.blob_id ?? null }))
    .filter((f) => /\b(use|uses|using|on|runs?|prefers?|never)\b/i.test(f.text))
    .slice(0, limit);
}

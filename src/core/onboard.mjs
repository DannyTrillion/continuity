/**
 * Being introduced, once.
 *
 * A chatbot that remembers has nothing to show in its first conversation: no
 * name to use, no preferences to apply, an empty memory page. The one thing
 * it is for does not appear until the second visit, and most people never
 * make one. So a new person can choose to spend a minute telling it who they
 * are, and their first real message is answered by someone who already knows.
 *
 * WHAT AN ANSWER BECOMES
 *
 * A memory, the same kind conversation produces, in the same namespace, with
 * a blob id of its own. Nothing here is a profile row in a side table: if an
 * answer is wrong it is corrected on the memory page like any other memory,
 * and if the person opts out it stops being read like any other memory.
 *
 * Written verbatim rather than through `analyze`. These sentences are already
 * facts — extraction would only get the chance to reword "short answers" into
 * something a search for it no longer finds.
 *
 * One write per step, not one per answer. A step with six chips ticked is one
 * sentence and one blob; the relayer allows sixty weighted requests a minute
 * and a person tapping through a form should not be what uses them up.
 */

import { createHash } from "node:crypto";
import { personNs, readLatest } from "./memory.mjs";
import { enqueueRemember, onSettled } from "./outbox.mjs";
import { rememberImage } from "./images.mjs";
import { setMode } from "./modes.mjs";

export const onboardNs = (personId) => `ws8::onboard::${personId}`;

/* What each choice is called in the sentence that gets stored. */
export const JOBS = {
  tutor: "a tutor for learning new things",
  coding: "a coding partner",
  planner: "a planner for trips, interviews and deadlines",
  reader: "a reader for links and documents",
  record: "a record of their own life and preferences",
  support: "a support desk",
};
const LENGTH = {
  short: "short answers",
  detailed: "detailed, thorough answers",
  depends: "answers only as long as the question needs",
};
const TONE = {
  plain: "a plain, direct tone",
  friendly: "a warm, friendly tone",
  blunt: "a blunt tone with no cushioning",
};
const TOOLS = new Set(["pnpm", "npm", "yarn", "bun", "Node", "Python", "TypeScript", "JavaScript", "React", "Go", "Rust",
  "VS Code", "macOS", "Windows", "Linux", "Docker", "Postgres"]);

const list = (items) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
const clean = (s, max = 60) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The sentence an answer is stored as, or null if there is nothing to store.
 * Third person, like everything the extractor writes, so the memory page and
 * the model read onboarding facts and conversation facts the same way.
 */
export function factFor(step, value) {
  if (step === "name") {
    const name = clean(value, 40).replace(/[^\p{L}\p{M} '.-]/gu, "").trim();
    // Capitalised, because that is how the name is read back out of memory.
    return name ? `User's name is ${name[0].toUpperCase()}${name.slice(1)}` : null;
  }
  if (step === "jobs") {
    const picked = (Array.isArray(value) ? value : []).filter((j) => JOBS[j]).map((j) => JOBS[j]);
    return picked.length ? `User's preference: wants the assistant as ${list(picked)}.` : null;
  }
  if (step === "style") {
    const parts = [LENGTH[value?.length], TONE[value?.tone] && `in ${TONE[value.tone]}`].filter(Boolean);
    return parts.length ? `User's preference: ${parts.join(", ")}.` : null;
  }
  if (step === "tools") {
    const picked = (Array.isArray(value) ? value : []).filter((t) => TOOLS.has(t));
    return picked.length ? `User uses ${list(picked)}.` : null;
  }
  return null;
}

/* ── receipts ──
   What each step wrote and the blob it landed in, so the page can show the
   memory arriving. In memory only: a receipt is a courtesy for the minute the
   person is watching, and the memory page is the permanent record. */
const receipts = new Map(); // personId -> Map(step -> { step, text, blobId, at })
const owners = new Map();   // job label -> { personId, step }

const slot = (personId) => {
  if (!receipts.has(personId)) receipts.set(personId, new Map());
  return receipts.get(personId);
};

onSettled(({ job, ok, stored = [] }) => {
  const who = owners.get(job.label);
  if (!who) return;
  owners.delete(job.label);
  const r = slot(who.personId).get(who.step);
  if (!r) return;
  if (ok && stored[0]?.blobId) r.blobId = stored[0].blobId;
  else if (!ok) r.failed = true;
  else r.settled = true; // landed, but the relayer had not named the blob yet
});

function track(personId, step, text, label) {
  owners.set(label, { personId, step });
  slot(personId).set(step, { step, text, blobId: null, at: new Date().toISOString() });
}

/* Four of the six jobs are modes. Saying you want a tutor is choosing one,
   so the introduction sets it rather than asking the same thing twice. */
const JOB_MODE = { tutor: "tutor", coding: "coding", planner: "planner", support: "support" };

/** Store one step's answer. Returns the receipt, or null if there was nothing to store. */
export function saveStep(personId, step, value) {
  if (step === "jobs" && Array.isArray(value)) {
    const first = value.find((j) => JOB_MODE[j]);
    if (first) setMode(personId, JOB_MODE[first]);
  }
  const text = factFor(step, value);
  if (!text) return null;
  const mark = createHash("sha1").update(text).digest("hex").slice(0, 12);
  const label = `onboard ${step} ${personId} ${mark}`;
  track(personId, step, text, label);
  // The key carries the content: the same answer twice is one memory, and a
  // changed answer is a new one that supersedes it.
  enqueueRemember(personNs(personId), text, { label, idempotencyKey: `onboard:${personId}:${step}:${mark}` });
  return slot(personId).get(step);
}

/** A picture dropped during onboarding goes to the picture bank like any other. */
export function savePicture(personId, attachment, said) {
  if (!attachment?.file || !attachment?.description) return null;
  const caption = clean(said, 200);
  track(personId, "picture", caption || attachment.description.slice(0, 120), `image ${attachment.file}`);
  const r = slot(personId).get("picture");
  r.file = attachment.file;
  rememberImage(personId, {
    file: attachment.file,
    name: attachment.name,
    description: attachment.description,
    surface: "web",
    said: caption || undefined,
  });
  return r;
}

/** Mark the introduction as done, with what was answered, so it is asked once. */
export function finish(personId, answers) {
  const record = { done: true, at: new Date().toISOString(), answers };
  enqueueRemember(onboardNs(personId), JSON.stringify(record), {
    label: `onboard done ${personId}`,
    idempotencyKey: `onboard:${personId}:done:${createHash("sha1").update(JSON.stringify(answers ?? {})).digest("hex").slice(0, 12)}`,
  });
  return record;
}

export const receiptsFor = (personId) => [...(receipts.get(personId)?.values() ?? [])];

/** Has this person been through it already? One read, and only when asked. */
export async function stateFor(personId) {
  try {
    const rec = await readLatest(onboardNs(personId));
    const parsed = rec ? JSON.parse(rec.text ?? rec) : null;
    return parsed?.done ? parsed : { done: false };
  } catch {
    return { done: false, unknown: true };
  }
}

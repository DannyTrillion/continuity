/**
 * Files you can ask for later.
 *
 * "That invoice I sent you in March" should bring the actual file back, on
 * whichever app you happen to be using — the same promise the picture bank
 * makes about photos, kept for everything that is not a photo.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE PICTURE BANK
 *
 * It did not, and that was the bug. Every attachment that was not a study
 * material went to `rememberImage`, so a PDF of someone's lease was written as
 * "a picture the user shared" and filed under Photos. It was findable only by
 * someone who thought to look for their contract among their photographs, and
 * the dashboard showed a Photos shelf with no image in it. A document is not a
 * picture of a document.
 *
 * WHAT IS STORED WHERE, HONESTLY
 *
 * The same split as pictures, for the same reason: Walrus Memory stores text,
 * so the bytes of a PDF cannot become a memory. What becomes the memory is
 * what the file *said* — the text extracted from it, summarised — plus a
 * reference to the file. That summary is the part recall can search, so it is
 * the part that makes the file findable; the bytes sit on the server's volume
 * and are what make it openable. Claiming the file itself lives on Walrus
 * would be a nicer sentence and a false one.
 *
 * WHY VERBATIM, AND WHY ITS OWN NAMESPACE
 *
 * Ordinary conversation goes through `analyze`, which extracts facts and
 * rewrites what it was given. A reference rewritten is a reference lost, so
 * these are written verbatim with `rememberFact`, into a namespace of their
 * own, and a search for a document never comes back with a sentence about
 * somebody's build setup.
 *
 * STUDY MATERIALS ARE NOT DUPLICATED HERE
 *
 * A file uploaded in Tutor mode still goes to `ws8::study::` alone, because it
 * is kept to be used again rather than merely recognised, and writing it twice
 * would cost two round trips against a budget of sixty a minute. The dashboard
 * unions the two namespaces instead, so the Files shelf shows everything the
 * person has sent without anything being stored twice.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { recall } from "./memory.mjs";
import { enqueueRemember, pendingFor } from "./outbox.mjs";
import { UPLOADS } from "./images.mjs";
import { getBlob } from "./walrus.mjs";

export const fileNs = (personId) => `ws8::file::${personId}`;

/* Same shape the picture bank uses, and deliberately plain so it survives a
   round trip through storage and a model's hands unharmed. */
const REF = /\[file:([\w.\-]+)\]/;
/* The Walrus blob holding the bytes, written into the sentence beside the
   local filename. This is the half that makes a file outlive the volume: the
   filename is only good while the server still has the bytes, and the blob id
   is good for as long as the storage is paid for. */
const WREF = /\[walrus:([\w.\-]+)\]/;
const PREFIX = /^A file the user shared on (\w+), ([^(:]+)(?:\(([^)]+)\))?: /;

const when = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * The sentence that gets stored.
 *
 * Pulled out of `rememberFile` so it can be tested against `parseFile` without
 * a relayer in the way. Both ends are regexes over the same sentence, written
 * at opposite ends of this file, and nothing but a round-trip test makes them
 * agree: change the prefix at one end and the shelf silently empties at the
 * other, while the memories sit on Walrus perfectly intact.
 */
export function fileSentence({ file, name, description, pages, surface, said, walrusBlob, at = Date.now() }) {
  /**
   * When the text could not be extracted, that failure must not become the
   * memory: "a file the assistant could not read" matches nothing anyone would
   * ever search for, which would make the file unfindable forever. The name
   * they gave it and what they said while sending it are real descriptions —
   * often better than a summary — so they stand in.
   */
  const unread = /^(a file|a document) the assistant could not read|^(scanned|no readable text)/i
    .test(description);
  const body = unread
    ? (said ? `a file they described as: ${said}` : `a file named ${name ?? "unknown"}, its text unreadable`)
    : description;

  return `A file the user shared on ${surface}, ${when(at)}` +
    `${name ? ` (${name})` : ""}: ${body}` +
    `${pages ? `\n${pages} pages.` : ""}` +
    `${said && !unread ? `\nThey said: ${said}` : ""}` +
    `\n[file:${file}]${walrusBlob ? `[walrus:${walrusBlob}]` : ""}`;
}

/**
 * Write a file into memory.
 *
 * Durable through the outbox like every other write, so a relayer bad patch
 * delays the memory rather than losing it. Nothing waits on this: the person
 * gets their reply now and the blob lands when it lands.
 */
export function rememberFile(personId, { file, name, description, pages, surface, said, walrusBlob, guard }) {
  if (!file || !description) return;

  enqueueRemember(fileNs(personId), fileSentence({ file, name, description, pages, surface, said, walrusBlob }), {
    label: `file ${file}`,
    idempotencyKey: `file:${file}`,
    guard,
  });
}

/** One stored sentence, back into the fields it was built from. */
export function parseFile(hit) {
  const ref = hit.text.match(REF)?.[1] ?? null;
  const blob = hit.text.match(WREF)?.[1] ?? null;
  const text = hit.text.replace(REF, "").replace(WREF, "").trim();
  const m = text.match(PREFIX);
  const rest = m ? text.slice(m[0].length) : text;
  const [head, said] = rest.split(/\nThey said: /);
  const onDisk = !!ref && existsSync(join(UPLOADS, ref));
  return {
    file: ref,
    /* Local while the bytes are here, Walrus once they are not. The dashboard
       asks for one url and gets whichever one currently works, so a redeploy
       that empties the volume changes where a file is fetched from and not
       whether it can be opened. */
    url: onDisk ? `/uploads/${ref}` : blob ? `/blob/${blob}` : null,
    available: onDisk || !!blob,
    onDisk,
    walrusBlob: blob,
    surface: m?.[1] ?? null,
    name: m?.[3]?.trim() ?? null,
    description: head.replace(/\n\d+ pages\.\s*$/, "").trim(),
    pages: Number(head.match(/\n(\d+) pages\.\s*$/)?.[1]) || null,
    said: said?.trim() ?? null,
    at: hit.created_at ?? null,
    blobId: hit.blob_id ?? null,
  };
}

/**
 * Everything they have sent that was not a picture.
 *
 * `available` used to mean "still on this server's volume", and a redeploy
 * turned a shelf of files into a shelf of apologies. It now means the bytes
 * can be fetched from somewhere — the volume if they are still there, Walrus
 * if they are not — which is the whole point of putting them on Walrus.
 */
export async function listFiles(personId, { limit = 40 } = {}) {
  const hits = await recall(fileNs(personId), "a file the user shared", { limit, maxTokens: 6000 })
    .catch(() => []);

  const seen = new Set();
  return hits
    .map(parseFile)
    .filter((f) => f.file && !seen.has(f.file) && seen.add(f.file))
    .sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
}


/**
 * Does this sound like somebody asking for a file back?
 *
 * The same keyword test the picture bank uses, and narrow for the same reason:
 * it runs on every turn, and the cost of being wrong is one wasted read rather
 * than a wrong answer. It has to name a document. "Send it" is far too broad,
 * and handing somebody a lease because they said "send it" about a link is
 * worse than not fetching at all.
 */
export function asksForFile(text) {
  const t = String(text ?? "");
  return /\b(file|files|document|documents|doc|docs|pdf|pdfs|notes?|slides?|spreadsheet|csv|invoice|receipt|contract|lease|report|paper|handout|attachment|transcript)\b/i.test(t);
}

/* Words that say nothing about WHICH file is meant. */
const NOISE = new Set(("a an and the of to in on at for with my me i you your it is was that this those these did do does " +
  "have has had file files document documents doc docs pdf attachment send sent share shared fetch bring back get find " +
  "show give stored store keep kept saved save one some any please can could would again so right").split(" "));

const words = (t) => String(t ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];

/** How well a queued file matches the question, when recall cannot see it yet. */
function nearness(query, text) {
  const asked = new Set(words(query).filter((w) => !NOISE.has(w)));
  if (!asked.size) return /\b(this|that|it|just sent|i sent|the one)\b/i.test(query) ? 0.45 : 0.95;
  const has = words(text).filter((w) => asked.has(w)).length;
  return has ? Math.max(0.2, 0.6 - has * 0.12) : 0.9;
}

/**
 * Find the files that best match what they asked for.
 *
 * Returns what it knows even when the bytes have gone, because "you sent me a
 * lease in March, but I no longer have the file" is a better answer than
 * silence — and far better than the one this replaces, which was the bot
 * flatly claiming it could not fetch a file at all while holding both a copy
 * on disk and a blob id on Walrus.
 */
export async function findFiles(personId, query, { limit = 3, offline = false } = {}) {
  const ns = fileNs(personId);
  let failed = offline;
  const hits = offline ? [] : await recall(ns, query, { limit, maxTokens: 900 })
    .catch(() => { failed = true; return []; });

  // Still on their way to Walrus: recall cannot see them, so match by hand.
  const waiting = pendingFor(ns).map((j) => ({
    text: j.text, distance: nearness(query, j.text), pending: true,
  }));

  const seen = new Set();
  const found = [...hits, ...waiting]
    .map((h) => ({ ...parseFile(h), distance: h.distance, pending: Boolean(h.pending) }))
    .filter((f) => (f.file && seen.has(f.file) ? false : (seen.add(f.file), true)))
    .sort((a, b) => a.distance - b.distance);

  found.failed = failed && found.length === 0;
  return found;
}

/**
 * The bytes, from wherever they still are.
 *
 * Disk first because it is instant, then Walrus, which is the whole reason the
 * blob id travels inside the memory: a redeploy takes the volume and the file
 * is still fetchable. Null only when neither can produce it, and then the
 * model is told to say so rather than to apologise vaguely.
 */
export async function loadFile(f) {
  if (!f?.file || !/^[\w.\-]+$/.test(f.file)) return null; // never let a name escape the directory
  try {
    const bytes = await readFile(join(UPLOADS, f.file));
    return { bytes, name: f.name ?? f.file, from: "disk" };
  } catch { /* not here any more; Walrus may still have it */ }

  if (!f.walrusBlob) return null;
  const bytes = await getBlob(f.walrusBlob);
  return bytes ? { bytes, name: f.name ?? f.file, from: "walrus" } : null;
}

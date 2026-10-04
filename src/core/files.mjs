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
import { recall } from "./memory.mjs";
import { enqueueRemember } from "./outbox.mjs";
import { UPLOADS } from "./images.mjs";

export const fileNs = (personId) => `ws8::file::${personId}`;

/* Same shape the picture bank uses, and deliberately plain so it survives a
   round trip through storage and a model's hands unharmed. */
const REF = /\[file:([\w.\-]+)\]/;
const PREFIX = /^A file the user shared on (\w+), ([^(:]+)(?:\(([^)]+)\))?: /;

const when = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * Write a file into memory.
 *
 * Durable through the outbox like every other write, so a relayer bad patch
 * delays the memory rather than losing it. Nothing waits on this: the person
 * gets their reply now and the blob lands when it lands.
 */
/**
 * The sentence that gets stored.
 *
 * Pulled out of `rememberFile` so it can be tested against `parseFile` without
 * a relayer in the way. Both ends are regexes over the same sentence, written
 * at opposite ends of this file, and nothing but a round-trip test makes them
 * agree: change the prefix at one end and the shelf silently empties at the
 * other, while the memories sit on Walrus perfectly intact.
 */
export function fileSentence({ file, name, description, pages, surface, said, at = Date.now() }) {
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
    `\n[file:${file}]`;
}

export function rememberFile(personId, { file, name, description, pages, surface, said, guard }) {
  if (!file || !description) return;

  enqueueRemember(fileNs(personId), fileSentence({ file, name, description, pages, surface, said }), {
    label: `file ${file}`,
    idempotencyKey: `file:${file}`,
    guard,
  });
}

/**
 * Everything they have sent that was not a picture.
 *
 * `available` is the honest bit. The bytes live on the server's volume, which
 * on a platform with an ephemeral filesystem does not survive a redeploy — the
 * memory does, because that is on Walrus. So the shelf can hold a file it can
 * describe and can no longer open, and says so rather than offering a link
 * that 404s.
 */
/** One stored sentence, back into the fields it was built from. */
export function parseFile(hit) {
  const ref = hit.text.match(REF)?.[1] ?? null;
  const text = hit.text.replace(REF, "").trim();
  const m = text.match(PREFIX);
  const rest = m ? text.slice(m[0].length) : text;
  const [head, said] = rest.split(/\nThey said: /);
  return {
    file: ref,
    url: ref ? `/uploads/${ref}` : null,
    available: !!ref && existsSync(join(UPLOADS, ref)),
    surface: m?.[1] ?? null,
    name: m?.[3]?.trim() ?? null,
    description: head.replace(/\n\d+ pages\.\s*$/, "").trim(),
    pages: Number(head.match(/\n(\d+) pages\.\s*$/)?.[1]) || null,
    said: said?.trim() ?? null,
    at: hit.created_at ?? null,
    blobId: hit.blob_id ?? null,
  };
}

export async function listFiles(personId, { limit = 40 } = {}) {
  const hits = await recall(fileNs(personId), "a file the user shared", { limit, maxTokens: 6000 })
    .catch(() => []);

  const seen = new Set();
  return hits
    .map(parseFile)
    .filter((f) => f.file && !seen.has(f.file) && seen.add(f.file))
    .sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
}

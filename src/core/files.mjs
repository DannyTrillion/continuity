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

/**
 * Pictures you can ask for later.
 *
 * "You know that photo of me ice skating — what did you think of it?" should
 * bring the actual picture back, on whichever app you happen to be using.
 *
 * WHAT IS STORED WHERE, HONESTLY
 *
 * Walrus Memory stores text. It has no binary path short of encrypting blobs
 * yourself and supplying your own embeddings, so the bytes of a photo cannot
 * become a memory. What becomes the memory is the description a vision model
 * wrote of it, plus a reference to the file — and the description is the part
 * that matters, because it is what recall can actually search. Asking for "me
 * ice skating" works by matching those words against a sentence about a person
 * on ice, not against pixels.
 *
 * So: the description lives on Walrus and is what makes the picture findable;
 * the bytes sit on the server's volume and are what makes it viewable. Saying
 * the images themselves are "stored on Walrus" would be a nicer sentence and a
 * false one.
 *
 * WHY THESE GET THEIR OWN NAMESPACE AND THEIR OWN WRITE
 *
 * Ordinary conversation goes through `analyze`, which extracts facts and
 * rewrites what it was given. That is right for turning chatter into memory
 * and fatal here: a reference rewritten is a reference lost. Pictures are
 * written verbatim with `rememberFact` instead, into a namespace of their own,
 * so the pointer survives exactly as issued and a search for a photo never
 * returns a sentence about someone's build setup.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { recall } from "./memory.mjs";
import { enqueueRemember, pendingFor } from "./outbox.mjs";
import { describeImage, canSee } from "./vision.mjs";
import { readDocument, canRead } from "./documents.mjs";
import { putBlob } from "./walrus.mjs";

/** Where the bytes live. Same volume as everything else durable. */
export const UPLOADS =
  process.env.UPLOADS_PATH ?? new URL("../../uploads", import.meta.url).pathname;

export const imageNs = (personId) => `ws8::img::${personId}`;

/* The reference, written into the memory text because text is all there is.
   Kept deliberately plain so it survives a round trip unharmed. */
const REF = /\[file:([\w.\-]+)\]/;
/* And the Walrus blob holding the bytes, so a picture outlives the volume the
   same way a file does. See files.mjs and walrus.mjs for why both halves. */
const WREF = /\[walrus:([\w.\-]+)\]/;

const when = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * Write a picture into memory.
 *
 * Durable through the outbox like every other write, so a relayer bad patch
 * delays the memory rather than losing it. Nothing waits on this: the person
 * gets their reply now and the blob lands when it lands.
 */
export function rememberImage(personId, { file, name, description, surface, said, walrusBlob, guard }) {
  if (!file || !description) return;

  // Everything a search might reasonably match on, in one sentence: what is in
  // the picture, what they said while sending it, and when. The file reference
  // trails behind, ignored by the reader and parsed back out by us.
  /**
   * When the vision model could not read it, its error must not become the
   * memory: "an image the assistant could not read" matches nothing anyone
   * would ever search for, which would make the picture unfindable forever.
   * What the person said while sending it is a real description — usually a
   * better one than a model would write — so it stands in.
   */
  const unread = /^an image the assistant could not read/.test(description);
  const body = unread
    ? (said ? `a picture they described as: ${said}` : "a picture, not yet described")
    : description;

  const text =
    `A picture the user shared on ${surface}, ${when(Date.now())}` +
    `${name ? ` (${name})` : ""}: ${body}` +
    `${said && !unread ? `\nThey said: ${said}` : ""}` +
    `\n[file:${file}]${walrusBlob ? `[walrus:${walrusBlob}]` : ""}`;

  enqueueRemember(imageNs(personId), text, {
    label: `image ${file}`,
    idempotencyKey: `img:${file}`,
    guard,
  });
}

/**
 * Does this sound like someone asking about a picture rather than sending one?
 *
 * A keyword test rather than a model call, because it runs on every turn and
 * the cost of being wrong is one wasted read, not a wrong answer. Narrow on
 * purpose: it has to name a picture. "Show me that" is far too broad, and
 * fetching the wrong photo because someone said "show me" about their code is
 * worse than not fetching at all.
 */
export function asksForPicture(text) {
  return /\b(pic|pics|picture|pictures|photo|photos|photograph|image|images|screenshot|screenshots|selfie|snap)\b/i
    .test(String(text ?? ""));
}

/**
 * Find the pictures that best match what they asked for.
 *
 * Returns descriptions even when the file has gone, because being able to say
 * "you sent me one of you on the ice in March, but I no longer have the file"
 * is far better than silence.
 */
export async function findImages(personId, query, { limit = 3, offline = false } = {}) {
  const ns = imageNs(personId);

  // Failing to read is not the same as having nothing, and the two used to
  // look identical from here: a rate-limited read came back as an empty list
  // and the bot told someone it had never been sent a picture. `offline` is
  // the turn that already knows memory is unreachable: it skips the read and
  // looks only at what is still queued here.
  let failed = offline;
  const hits = offline ? [] : await recall(ns, query, { limit, maxTokens: 500 }).catch(() => { failed = true; return []; });

  // Pictures still on their way to Walrus. Recall cannot see them, so they
  // are matched here by hand: closely if the question points at something
  // just sent ("this image", "the one I sent"), or shares a real word with
  // what the picture shows.
  const waiting = pendingFor(ns).map((j) => ({ text: j.text, distance: nearness(query, j.text), pending: true }));

  const seen = new Set();
  const found = [...hits, ...waiting]
    .map((h) => {
      const file = h.text.match(REF)?.[1] ?? null;
      return {
        file,
        // The reference is machinery; it should never reach the model or the
        // person, who would only wonder what it meant.
        description: h.text.replace(REF, "").trim(),
        distance: h.distance,
        pending: Boolean(h.pending),
        available: !!file && existsSync(join(UPLOADS, file)),
      };
    })
    .filter((p) => (p.file && seen.has(p.file) ? false : (seen.add(p.file), true)))
    .sort((a, b) => a.distance - b.distance);

  found.failed = failed && found.length === 0;
  return found;
}

/* Words that say nothing about which picture is meant. */
const GENERIC = new Set(("a an and the of to in on at for with my me i you your it is was that this those these did do does have has had " +
  "picture pictures photo photos image images pic pics screenshot selfie snap user shared said they show send sent fetch bring back " +
  "get find stored store keep kept saved save one some any please can could would so right").split(" "));
const POINTS_BACK = /\b(this|that|it|just (sent|now|shared)|i (just )?(sent|shared|gave|showed)|earlier|a moment ago|the one)\b/i;

function nearness(query, text) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !GENERIC.has(w)) ?? []);
  const q = words(query), t = words(text);
  let shared = 0;
  for (const w of q) if (t.has(w)) shared++;
  if (shared >= 2) return 0.3;
  if (shared === 1) return 0.45;
  return POINTS_BACK.test(query) ? 0.5 : 0.8;
}

/* The sentence rememberImage writes starts with where and when; the gallery
   shows those as pills, so the description itself is what is left. */
const PREFIX = /^A picture the user shared on (\w+), ([^:(]+?)(?: \(([^)]*)\))?: /;

/**
 * Every picture this person has shared, newest first, for the gallery.
 *
 * Read with a fixed query rather than the person's words, because a gallery
 * is not a search: it wants all of them. Recall is semantic and capped, so
 * "all" means the nearest few dozen to a sentence every one of them starts
 * with — which is, in practice, all of them.
 */
export async function listImages(personId, { limit = 40 } = {}) {
  const hits = await recall(imageNs(personId), "a picture the user shared", { limit, maxTokens: 6000 })
    .catch(() => []);
  const seen = new Set();
  return hits
    .map((h) => {
      const file = h.text.match(REF)?.[1] ?? null;
      const blob = h.text.match(WREF)?.[1] ?? null;
      const text = h.text.replace(REF, "").replace(WREF, "").trim();
      const m = text.match(PREFIX);
      const [description, said] = (m ? text.slice(m[0].length) : text).split(/\nThey said: /);
      const onDisk = !!file && existsSync(join(UPLOADS, file));
      return {
        file,
        // Local while the bytes are here, Walrus once they are not.
        url: onDisk ? `/uploads/${file}` : blob ? `/blob/${blob}` : null,
        available: onDisk || !!blob,
        onDisk,
        walrusBlob: blob,
        surface: m?.[1] ?? null,
        name: m?.[3] ?? null,
        description: description.trim(),
        said: said?.trim() ?? null,
        at: h.created_at ?? null,
        blobId: h.blob_id ?? null,
      };
    })
    .filter((p) => p.file && !seen.has(p.file) && seen.add(p.file))
    .sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
}

/** The bytes, ready to hand to whichever surface asked. */
export async function loadImage(file) {
  if (!file || !/^[\w.\-]+$/.test(file)) return null; // never let a name escape the directory
  try {
    const png = await readFile(join(UPLOADS, file));
    return { png, name: file };
  } catch {
    return null;
  }
}

/**
 * Take something someone sent and turn it into an attachment the turn can use.
 *
 * One implementation for all three surfaces. The web had its own copy of this
 * for a while and the two drifted, which is how attachments ended up working
 * in one place and silently not in another — the kind of bug that never
 * errors and so never gets noticed.
 *
 * Returns the shape `handleTurn` expects: somewhere to fetch the bytes back
 * from, and a description, which is the part that becomes the memory.
 */
export async function storeAttachment({ bytes, name, type, hint }) {
  // The type wins over the name: the browser re-encodes big photos as JPEG
  // and keeps the original filename, so "IMG_2041.png" may well hold a JPEG.
  const fromType = guessExt(type);
  const ext = (fromType !== "bin" ? fromType
    : String(name ?? "").match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? fromType).toLowerCase();
  const id = randomUUID();
  const file = `${id}.${ext}`;

  await mkdir(UPLOADS, { recursive: true });
  await writeFile(join(UPLOADS, file), bytes);

  /* The bytes go to Walrus too, started now and collected at the end.
     Describing an attachment already takes seconds — a vision call or a
     document read — so the upload rides alongside it and costs almost no wall
     clock. It is deliberately not awaited here: if Walrus is slow or down,
     the person still gets their reply and their file, and only durability is
     lost. The local copy remains the fast path; the blob is what survives a
     redeploy taking the volume with it. */
  const uploading = putBlob(bytes);

  let description;
  let sawIt = false;
  if (canRead(type, ext) && !canSee(type)) {
    /* A text file is read rather than looked at, and what it says becomes the
       memory — the same way the description of a photo does. Before this it
       stored "a TXT file named notes.txt (4KB)", which is unfindable by
       anything anyone would type. One retry: the model behind this is the
       same one that answers, and it has the same bad minutes. */
    let read = await readDocument({ bytes, name, type, hint });
    if (!read.ok) {
      await new Promise((r) => setTimeout(r, 900));
      read = await readDocument({ bytes, name, type, hint });
    }
    if (read.ok) { description = read.description; sawIt = true; }
    else {
      console.error(`[documents] could not read ${file}: ${read.error}`);
      description = `a ${ext.toUpperCase()} file named "${name ?? "untitled"}" that I could not read (${read.error})`;
    }
  } else if (canSee(type)) {
    const url = `data:${type};base64,${bytes.toString("base64")}`;
    // A few tries, spaced out. The provider behind the vision model fails
    // intermittently and so does the network, and a picture nobody could
    // describe is a picture nobody can find again — the description is the
    // only thing recall has to search on. Each failure is logged, because
    // for a while none were and a "could not read" reply had no cause.
    let seen;
    // Three rounds; each round already walks the whole model cascade.
    for (const [i, wait] of [0, 1500, 4000].entries()) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      seen = await describeImage(url, { hint });
      if (seen.ok) break;
      console.error(`[vision] attempt ${i + 1} failed for ${file}: ${seen.error}`);
    }
    if (seen.ok) { description = seen.description; sawIt = true; }
    else description = `an image the assistant could not read (${seen.error})`;
  } else {
    description = `a ${ext.toUpperCase()} file named "${name ?? "untitled"}" (${Math.round(bytes.length / 1024)}KB)`;
  }

  /* `kind` is what the caller needs to decide where this belongs. A photo and
     a set of lecture slides are both attachments and want storing in
     completely different places — one in the picture bank, one among the
     things somebody is studying — and only this function knows which path the
     bytes actually took. */
  const kind = canRead(type, ext) && !canSee(type) ? "document" : canSee(type) ? "image" : "other";
  const stored = await uploading;
  return {
    id, file, url: `/uploads/${file}`, name: name ?? null, type: type ?? null, description, sawIt, kind,
    // Null whenever the upload did not land. Callers must treat it that way:
    // the file still works without it, it just stops being durable.
    walrusBlob: stored?.blobId ?? null,
    walrusNetwork: stored?.network ?? null,
  };
}

const guessExt = (type) =>
  ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" })[String(type)] ?? "bin";

/**
 * Things somebody is trying to learn.
 *
 * A study material is a file the person uploaded to be taught from: lecture
 * notes, a handout, a chapter. It differs from every other attachment in one
 * way that matters — it is kept to be *used again*, not just recognised later.
 * So it gets a namespace of its own rather than landing in the picture bank,
 * where a set of lecture slides would sit under "Photos" and be found by
 * nobody.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 *
 * One memory per material: a summary, findable by search, with a reference to
 * the file trailing behind it. NOT the material itself, chunked. That choice
 * is forced by arithmetic rather than taste — a write averages fourteen
 * seconds against mainnet and the account allows sixty requests a minute and a
 * thousand an hour across every surface at once. A twenty-page PDF split into
 * eighty memories would take twenty minutes and spend a third of the hourly
 * budget on one upload.
 *
 * It is also unnecessary. `storeAttachment` already writes the bytes to the
 * same volume everything else durable lives on, so the full text is a disk
 * read away whenever a question needs writing from it. Memory holds what makes
 * the material *findable*; the disk holds what makes it *usable*.
 *
 * WHAT A MISTAKE IS FOR
 *
 * Getting a question wrong writes a memory, and that is the part of this worth
 * building. Any model can quiz someone from a document. Remembering on Friday
 * that they missed the same question on Tuesday — and saying so from a
 * different app than the one they were quizzed in — is the thing this project
 * exists to demonstrate.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { recall } from "./memory.mjs";
import { enqueueRemember } from "./outbox.mjs";
import { UPLOADS } from "./images.mjs";
import { readDocument } from "./documents.mjs";

export const studyNs = (personId) => `ws8::study::${personId}`;

/* Same shape as the picture bank's, and deliberately plain so it survives a
   round trip through storage and a model's hands unharmed. */
const REF = /\[file:([\w.\-]+)\]/;

const when = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * Keep a material, and say what it was.
 *
 * Durable through the outbox like every other write: the person is told it
 * landed when the relayer says so, and a bad patch delays it rather than
 * losing it.
 */
export function rememberMaterial(personId, { file, name, description, pages, surface, guard }) {
  if (!file || !description) return null;

  const title = name ?? "a document";
  const text =
    `Study material the user uploaded on ${surface}, ${when(Date.now())}: ${title}` +
    `${pages ? ` (${pages} pages)` : ""}.\n${description}` +
    `\n[file:${file}]`;

  enqueueRemember(studyNs(personId), text, {
    label: `material ${file}`,
    idempotencyKey: `study:${file}`,
    guard,
  });
  return { file, name: title, pages: pages ?? 0, at: new Date().toISOString() };
}

/**
 * Record that a question was missed.
 *
 * Written as a sentence rather than a row, because it has to survive being
 * read back by a model months later and across a surface that knows nothing
 * about quizzes. "They got this wrong" is the useful half; what the right
 * answer was is the half that makes it teachable.
 */
export function rememberMistake(personId, { question, chose, correct, material, guard }) {
  if (!question || !correct) return;
  const text =
    `In a quiz on ${material ?? "their study material"}, ${when(Date.now())}, ` +
    `the user got this wrong: "${question}" — they answered "${chose ?? "nothing"}", ` +
    `but the answer is "${correct}".`;

  enqueueRemember(studyNs(personId), text, {
    label: `missed ${String(question).slice(0, 40)}`,
    // The same person missing the same question twice is two facts, not one:
    // the repeat is the signal worth having.
    idempotencyKey: `miss:${personId}:${Date.now()}`,
    guard,
  });
}

/** Strip the file reference out of a stored memory. It is machinery. */
const bodyOf = (t) => String(t ?? "").replace(REF, "").trim();

/**
 * Everything they have uploaded to learn from, newest first.
 *
 * Mistakes live in the same namespace, so they are filtered out here by the
 * absence of a file reference — a missed question has no file behind it.
 */
export async function listMaterials(personId, { limit = 20 } = {}) {
  const hits = await recall(studyNs(personId), "a study material the user uploaded", {
    limit,
    maxTokens: 4000,
  }).catch(() => []);

  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const file = h.text?.match(REF)?.[1];
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const body = bodyOf(h.text);
    out.push({
      file,
      name: body.match(/: ([^.\n(]+?)(?: \(\d+ pages\))?\./)?.[1]?.trim() ?? "a document",
      summary: body,
      blobId: h.blob_id ?? null,
      at: h.created_at ?? null,
    });
  }
  return out;
}

/** What they have got wrong, for a tutor that is supposed to notice. */
export async function listMistakes(personId, { limit = 10 } = {}) {
  const hits = await recall(studyNs(personId), "a question the user got wrong in a quiz", {
    limit,
    maxTokens: 2000,
  }).catch(() => []);
  return hits
    .filter((h) => !REF.test(h.text ?? "") && /got this wrong/i.test(h.text ?? ""))
    .map((h) => ({ text: h.text, blobId: h.blob_id ?? null, at: h.created_at ?? null }));
}

/**
 * The words of a material, read back off the volume.
 *
 * Deliberately not from memory: memory holds a summary, and you cannot write a
 * fair question from a summary of the thing you are asking about. A PDF is
 * re-extracted on each read rather than cached, which costs a second and keeps
 * one copy of the truth.
 */
export async function materialText(file, { limit = 24_000 } = {}) {
  if (!REF.test(`[file:${file}]`)) throw new Error("bad file reference");
  const bytes = await readFile(join(UPLOADS, file));
  const name = String(file);
  const read = await readDocument({ bytes, name, type: undefined });
  if (!read.ok) throw new Error(read.error ?? "could not read it back");
  return String(read.text ?? "").slice(0, limit);
}

/**
 * Materials and misses in one read.
 *
 * `listMaterials` and `listMistakes` each cost a recall, and the page wants
 * both. They live in the same namespace and are told apart by whether the
 * memory carries a file reference — so one broad read answers both, which
 * halves what the page spends against a budget shared with every chat turn.
 */
export async function studyShelf(personId, { limit = 24 } = {}) {
  const hits = await recall(studyNs(personId), "study materials and questions got wrong", {
    limit,
    maxTokens: 5000,
  }).catch(() => []);

  const materials = [];
  const missed = [];
  const seen = new Set();

  for (const h of hits) {
    const text = String(h.text ?? "");
    const file = text.match(REF)?.[1];
    if (file) {
      if (seen.has(file)) continue;
      seen.add(file);
      const body = bodyOf(text);
      materials.push({
        file,
        name: body.match(/: ([^.\n(]+?)(?: \(\d+ pages\))?\./)?.[1]?.trim() ?? "a document",
        summary: body,
        blobId: h.blob_id ?? null,
        at: h.created_at ?? null,
      });
    } else if (/got this wrong/i.test(text)) {
      missed.push({ text, blobId: h.blob_id ?? null, at: h.created_at ?? null });
    }
  }
  return { materials, missed };
}

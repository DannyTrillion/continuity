/**
 * Where each memory came from, and who has read it since.
 *
 * Walrus stores the sentence and the time it was written; it does not record
 * which app the person was using, or that Discord read something Telegram
 * wrote. That crossing is the whole claim of this project, and until now
 * nothing observed it — so the dashboard could assert it but not show it.
 *
 * Kept beside the memories rather than inside them: a parallel record per blob
 * would double the write cost and pollute recall with metadata sentences. This
 * is an index, so it is allowed to be local and lossy. A blob with no entry
 * simply reports "unknown", which is true.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";

const FILE = process.env.PROVENANCE_PATH ?? new URL("../../provenance.json", import.meta.url).pathname;
const MAX_READS = 12; // per blob, newest kept

/** blobId -> { wroteOn, at, reads: [{ surface, at }] } */
let index = {};
let dirty = false;

try {
  if (existsSync(FILE)) index = JSON.parse(readFileSync(FILE, "utf8"));
} catch {
  index = {};
}

const save = async () => {
  if (!dirty) return;
  dirty = false;
  const tmp = `${FILE}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(index));
    await rename(tmp, FILE);
  } catch (err) {
    console.error("[provenance] could not save:", err.message);
  }
};
setInterval(save, 8000).unref();

/** Called when a write settles, with the surface the conversation happened on. */
export function noteWrite(blobId, surface) {
  if (!blobId) return;
  const entry = (index[blobId] ??= { reads: [] });
  entry.wroteOn = surface ?? entry.wroteOn ?? "unknown";
  entry.at ??= new Date().toISOString();
  dirty = true;
}

/** Called when a memory is recalled, so "read on Discord" becomes observable. */
export function noteRead(blobIds, surface) {
  const at = new Date().toISOString();
  for (const id of blobIds) {
    if (!id) continue;
    const entry = (index[id] ??= { reads: [] });
    const last = entry.reads[entry.reads.length - 1];
    // Don't log the same surface twice in a row within a minute; a turn reads
    // the same memory several times and that is noise, not history.
    if (last && last.surface === surface && Date.now() - Date.parse(last.at) < 60_000) continue;
    entry.reads.push({ surface, at });
    if (entry.reads.length > MAX_READS) entry.reads.shift();
    dirty = true;
  }
}

export function provenanceFor(blobId) {
  const entry = index[blobId];
  if (!entry) return { wroteOn: null, reads: [], surfaces: [], crossed: false };
  const surfaces = [...new Set(entry.reads.map((r) => r.surface))];
  return {
    wroteOn: entry.wroteOn ?? null,
    at: entry.at ?? null,
    reads: entry.reads,
    readCount: entry.reads.length,
    surfaces,
    // The claim, made checkable: written on one app, read on another.
    crossed: Boolean(entry.wroteOn && surfaces.some((s) => s !== entry.wroteOn)),
  };
}

export const provenanceStats = () => {
  const all = Object.values(index);
  return {
    tracked: all.length,
    everRead: all.filter((e) => e.reads.length).length,
    crossedSurfaces: Object.keys(index).filter((id) => provenanceFor(id).crossed).length,
  };
};

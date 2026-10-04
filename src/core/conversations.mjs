/**
 * Past conversations, kept so they can be reopened and continued.
 *
 * Deliberately separate from memory. A memory is a fact worth carrying
 * forever — "you run Node 22". A conversation is the transcript it came from,
 * and the two want different treatment: facts are extracted, deduped and
 * recalled semantically, while transcripts are read whole and in order.
 *
 * One blob per conversation, not per turn. Writing every message would double
 * the cost of a turn against an hourly quota we already strain, so a
 * conversation is flushed once it goes quiet.
 */

import { recall } from "./memory.mjs";
import { enqueueRemember } from "./outbox.mjs";
import { randomUUID } from "node:crypto";

const NS = (personId) => `ws8::convo::${personId}`;
const IDLE_MS = Number(process.env.CONVO_IDLE_MS ?? 8 * 60 * 1000);
const MAX_CHARS = 7000;
const MAX_TURNS = 40;

/** personId -> { id, surface, startedAt, turns, timer, lastAt } */
const open = new Map();

const titleFrom = (turns) => {
  const first = turns.find((t) => t.you)?.you ?? "Conversation";
  return first.replace(/\s+/g, " ").trim().slice(0, 70);
};

/** Trim from the front: the end of a conversation is the part worth keeping. */
function fit(turns) {
  let kept = turns.slice(-MAX_TURNS);
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_CHARS) kept = kept.slice(1);
  return kept;
}

async function flush(personId) {
  const convo = open.get(personId);
  if (!convo || !convo.turns.length) return;
  open.delete(personId);
  clearTimeout(convo.timer);

  const record = {
    id: convo.id,
    title: titleFrom(convo.turns),
    surface: convo.surface,
    startedAt: convo.startedAt,
    endedAt: new Date(convo.lastAt).toISOString(),
    turns: fit(convo.turns),
  };

  // Through the outbox, like every other write. Saving directly meant a
  // conversation that closed during a relayer rate limit was simply gone:
  // the 429 was logged and nothing retried it.
  enqueueRemember(NS(personId), JSON.stringify(record), {
    label: `conversation ${record.title.slice(0, 40)}`,
    idempotencyKey: `convo:${convo.id}`,
  });
}

/**
 * Record one exchange. The conversation saves itself once it goes quiet.
 *
 * `files` carries the pictures in the exchange — the one they attached and
 * the one it brought back — as file references, so a reopened conversation
 * shows them instead of a bare "see" with nothing to see. Only the reference
 * is kept; the bytes stay in uploads, like everywhere else.
 */
export function record(personId, surface, you, bot, files = {}) {
  if (!personId || !you) return;
  let convo = open.get(personId);

  if (!convo) {
    convo = { id: randomUUID(), surface, startedAt: new Date().toISOString(), turns: [] };
    open.set(personId, convo);
  }
  const turn = { you, bot, at: new Date().toISOString() };
  if (files.attached?.file) turn.attached = { file: files.attached.file, name: files.attached.name ?? null };
  if (files.picture?.file) turn.picture = { file: files.picture.file };
  convo.turns.push(turn);
  convo.lastAt = Date.now();

  clearTimeout(convo.timer);
  convo.timer = setTimeout(() => flush(personId), IDLE_MS);
  convo.timer.unref?.();
}

/** Save everything in flight — called before the process goes away. */
export const flushAll = () => Promise.all([...open.keys()].map(flush));

/**
 * End the conversation in progress, so the next message begins a new one.
 *
 * It is saved, not discarded. Everything said is already queued for Walrus and
 * append-only storage cannot unwrite it, so offering to "delete this
 * conversation" would be a lie on the second word. What this actually buys is
 * a boundary: the next thing you say starts its own thread in History instead
 * of being filed under whatever you were talking about an hour ago.
 */
export function closeOpen(personId) {
  const convo = open.get(personId);
  if (!convo) return 0;
  const turns = convo.turns.length;
  clearTimeout(convo.timer);
  flush(personId);
  return turns;
}

/**
 * Past conversations, newest first. The one still in progress is included so
 * the list is never mysteriously missing what the person just said.
 */
export async function list(personId) {
  const hits = await recall(NS(personId), "conversation transcript", { limit: 25, maxTokens: 12000 })
    .catch(() => []);

  const saved = hits
    .map((h) => {
      try {
        return { ...JSON.parse(h.text), blobId: h.blob_id ?? null };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const live = open.get(personId);
  if (live?.turns.length) {
    saved.push({
      id: live.id,
      title: titleFrom(live.turns),
      surface: live.surface,
      startedAt: live.startedAt,
      endedAt: new Date(live.lastAt).toISOString(),
      turns: live.turns,
      live: true,
    });
  }

  const seen = new Set();
  return saved
    .filter((c) => (seen.has(c.id) ? false : seen.add(c.id)))
    .sort((a, b) => Date.parse(b.endedAt ?? 0) - Date.parse(a.endedAt ?? 0));
}

export async function get(personId, id) {
  const all = await list(personId);
  return all.find((c) => c.id === id) ?? null;
}

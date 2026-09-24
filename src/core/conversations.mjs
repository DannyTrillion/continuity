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

import { rememberFact, recall } from "./memory.mjs";
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

  try {
    await rememberFact(NS(personId), JSON.stringify(record), { idempotencyKey: `convo:${convo.id}` });
  } catch (err) {
    console.error("[conversations] could not save:", err.message);
  }
}

/** Record one exchange. The conversation saves itself once it goes quiet. */
export function record(personId, surface, you, bot) {
  if (!personId || !you) return;
  let convo = open.get(personId);

  if (!convo) {
    convo = { id: randomUUID(), surface, startedAt: new Date().toISOString(), turns: [] };
    open.set(personId, convo);
  }
  convo.turns.push({ you, bot, at: new Date().toISOString() });
  convo.lastAt = Date.now();

  clearTimeout(convo.timer);
  convo.timer = setTimeout(() => flush(personId), IDLE_MS);
  convo.timer.unref?.();
}

/** Save everything in flight — called before the process goes away. */
export const flushAll = () => Promise.all([...open.keys()].map(flush));

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

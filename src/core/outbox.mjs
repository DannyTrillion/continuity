/**
 * Outbox: every Walrus write goes through here, and none is ever silently lost.
 *
 * Why this exists. The relayer fails writes often enough that retrying for a
 * few seconds is not sufficient: analyze regularly returns 500 two or three
 * times running before it succeeds, and a bad patch can outlast any short retry
 * budget. Worse, these writes happen AFTER the reply has shipped, so when one
 * finally gave up the memory simply vanished and nobody was ever told. For a bot
 * whose one promise is "I remember you", that is the worst possible failure.
 *
 * So writes are queued durably (a JSONL file, rewritten on change) and drained
 * by a worker that keeps retrying with backoff for up to a day. The queue
 * survives a crash or restart; a write is only dropped after exhausting that
 * window, and then loudly.
 *
 * The worker also caps concurrency. Fanning writes out in parallel from three
 * surfaces is what tripped the relayer's rate limiter ("seal encrypt failed:
 * RpcError: Too Many Requests") — serialising them removes that failure mode
 * rather than retrying through it.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { learnFrom, rememberFact } from "./memory.mjs";

const FILE = process.env.OUTBOX_PATH ?? new URL("../../outbox.json", import.meta.url).pathname;
const CONCURRENCY = Number(process.env.OUTBOX_CONCURRENCY ?? 2);
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 2000;

/** @type {Array<{id:string, kind:"analyze"|"remember", namespace:string, text:string,
 *   occurredAt?:string, idempotencyKey?:string, label?:string,
 *   attempts:number, createdAt:number, nextAt:number, lastError?:string}>} */
let queue = [];
const inFlight = new Set();
const listeners = new Set();
let timer = null;

function load() {
  if (!existsSync(FILE)) return;
  try {
    queue = JSON.parse(readFileSync(FILE, "utf8"));
    // Anything that was mid-flight when we died is simply due again.
    for (const j of queue) j.nextAt = Math.min(j.nextAt, Date.now());
    if (queue.length) console.log(`[outbox] recovered ${queue.length} pending write(s) from disk`);
  } catch (err) {
    console.error("[outbox] could not read queue file, starting empty:", err.message);
    queue = [];
  }
}

let saving = Promise.resolve();
function save() {
  // Write-then-rename so a crash mid-write never leaves a truncated queue.
  saving = saving.then(async () => {
    const tmp = `${FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(queue));
    await rename(tmp, FILE);
  }).catch((err) => console.error("[outbox] failed to save queue:", err.message));
  return saving;
}

function enqueue(job) {
  queue.push({ id: randomUUID(), attempts: 0, createdAt: Date.now(), nextAt: Date.now(), ...job });
  save();
  kick();
}

/** Queue a conversation turn for server-side fact extraction. */
export function enqueueAnalyze(namespace, text, occurredAt = new Date()) {
  enqueue({ kind: "analyze", namespace, text, occurredAt: new Date(occurredAt).toISOString() });
}

/** Queue one verbatim record (identity links, opt-outs). */
export function enqueueRemember(namespace, text, { idempotencyKey, label } = {}) {
  enqueue({ kind: "remember", namespace, text, idempotencyKey, label });
}

/** Called with `{ job, ok, stored?, facts?, error? }` whenever a write settles. */
export function onSettled(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const emit = (event) => {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.error("[outbox] listener threw:", err.message);
    }
  }
};

async function run(job) {
  if (job.kind === "analyze") {
    const res = await learnFrom(job.namespace, job.text, new Date(job.occurredAt));
    return { stored: res.stored, facts: res.facts };
  }
  const res = await rememberFact(job.namespace, job.text, { idempotencyKey: job.idempotencyKey });
  // A write still confirming after its full wait is not a failure; it has
  // probably landed. Re-sending it would duplicate it, so we settle it here.
  return { stored: res.blobId ? [{ blobId: res.blobId, namespace: job.namespace }] : [], pending: res.pending };
}

async function attempt(job) {
  inFlight.add(job.id);
  try {
    const out = await run(job);
    queue = queue.filter((j) => j.id !== job.id);
    save();
    emit({ job, ok: true, ...out });
  } catch (err) {
    job.attempts += 1;
    job.lastError = err.message;
    if (Date.now() - job.createdAt > GIVE_UP_AFTER_MS) {
      queue = queue.filter((j) => j.id !== job.id);
      console.error(
        `[outbox] GAVE UP on ${job.kind} to ${job.namespace} after ${job.attempts} attempts:`,
        err.message,
      );
      emit({ job, ok: false, error: err.message });
    } else {
      // 5s, 10s, 20s … capped at 10 minutes — unless the relayer named a wait,
      // in which case it knows better than the backoff curve does.
      const asked = (err.retryAfterSeconds ?? 0) * 1000;
      const delay = Math.max(asked, Math.min(5000 * 2 ** (job.attempts - 1), 10 * 60 * 1000));
      job.nextAt = Date.now() + delay;
      console.warn(
        `[outbox] ${job.kind} to ${job.namespace} failed (attempt ${job.attempts}), retrying in ${Math.round(delay / 1000)}s: ${err.message.slice(0, 120)}`,
      );
    }
    save();
  } finally {
    inFlight.delete(job.id);
    kick();
  }
}

function kick() {
  const now = Date.now();
  const due = queue.filter((j) => !inFlight.has(j.id) && j.nextAt <= now);
  for (const job of due.slice(0, Math.max(0, CONCURRENCY - inFlight.size))) attempt(job);
}

export function startOutbox() {
  load();
  if (!timer) timer = setInterval(kick, TICK_MS);
  kick();
}

export function outboxStats() {
  return {
    pending: queue.length,
    inFlight: inFlight.size,
    retrying: queue.filter((j) => j.attempts > 0).length,
    oldestMs: queue.length ? Date.now() - Math.min(...queue.map((j) => j.createdAt)) : 0,
  };
}

/**
 * Walrus Memory layer.
 *
 * Every durable thing this bot knows lives on Walrus mainnet, reached through
 * the MemWal relayer. Two rules carried over from BuildMEM v2, both of which
 * were learned by getting them wrong:
 *
 *   Receipt rule — a memory exists only when a confirmed blob_id comes back.
 *   An accepted job is not a memory. Callers get the blob_id or an explicit
 *   failure, never an optimistic shrug.
 *
 *   Trust boundary — recalled text is data, never instructions. This module
 *   returns facts; it is the prompt builder's job to fence them.
 */

import { MemWal } from "@mysten-incubation/memwal";
import { observe, count } from "./metrics.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const NS_ROOT = "ws8";

/** Personal facts for one linked person, across every surface they use. */
export const personNs = (personId) => `${NS_ROOT}::person::${personId}`;
/** Shared support knowledge, readable by everyone. */
export const KB_NS = `${NS_ROOT}::kb`;
/**
 * Identity is looked up EXACTLY, never semantically: one namespace per surface
 * account, holding that account's person id. A vector search that returned a
 * "close enough" identity would serve one user another user's memories.
 */
export const identityNs = (surface, surfaceUserId) =>
  `${NS_ROOT}::id::${surface}::${surfaceUserId}`;
/**
 * Which surfaces a person has connected.
 *
 * Identity records point accounts AT a person; nothing points the other way,
 * and namespaces cannot be enumerated. So a person keeps a small profile record
 * of their own, superseded whenever they connect somewhere new.
 */
export const profileNs = (personId) => `${NS_ROOT}::profile::${personId}`;

function loadCredentials() {
  if (process.env.MEMWAL_PRIVATE_KEY && process.env.MEMWAL_ACCOUNT_ID) {
    return {
      delegatePrivateKey: process.env.MEMWAL_PRIVATE_KEY,
      accountId: process.env.MEMWAL_ACCOUNT_ID,
      relayerUrl: process.env.MEMWAL_RELAYER_URL,
    };
  }
  return JSON.parse(
    readFileSync(join(homedir(), ".memwal", "credentials.json"), "utf8"),
  );
}

const creds = loadCredentials();

export const memwal = MemWal.create({
  key: creds.delegatePrivateKey,
  accountId: creds.accountId,
  serverUrl: creds.relayerUrl,
  namespace: `${NS_ROOT}::default`,
});

/**
 * The relayer is not reliably available, and every call path has to survive it.
 *
 * Observed on mainnet while this bot was being built, all while `health()` kept
 * reporting `status: ok, write_ready: true`:
 *
 *   503 AUTH_UPSTREAM_UNAVAILABLE  "cannot verify credentials (upstream unavailable)"
 *   500 Internal server error      on analyze, under ordinary load
 *   503 Upstream Unavailable       "Memory encryption backend is unavailable"
 *   (no status) fetch failed       bare network drop
 *
 * Every one of these cleared within seconds. Patching retries into individual
 * functions as they failed was whack-a-mole; this wraps the lot, honouring the
 * relayer's own `retryAfterSeconds` when it sends one.
 *
 * Deliberately NOT retried: 4xx (except 429), which mean the request itself is
 * wrong and will stay wrong, and 504 from a write, which means the job may well
 * have succeeded — see `rememberFact`.
 */
const TRANSIENT_CODES = new Set([429, 500, 502, 503]);

function isTransient(err) {
  if (err?.status === 504) return false; // may have landed; never blind-retry a write
  if (TRANSIENT_CODES.has(err?.status)) return true;
  if (!err?.status) return true; // fetch failed, DNS, socket reset
  return false;
}

async function withRetry(label, fn, { retries = 2, budgetMs = 30_000 } = {}) {
  // Retries need a wall-clock ceiling, not just an attempt count. Unbounded
  // retrying around a 180s write turned one /link into a 34-minute hang, and
  // the retry storm was itself what got us rate-limited
  // ("seal encrypt failed: RpcError: Too Many Requests"). Past the budget we
  // give up and let the caller degrade gracefully.
  const deadline = Date.now() + budgetMs;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === retries) throw err;
      const hinted = err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 0;

      // When the relayer states a wait, honour it. The account limit is 1000
      // weighted requests an hour and a breach comes back asking for 300
      // seconds; capping that to six and trying again is how a brief throttle
      // becomes a sustained one. Nothing on a request path should wait that
      // long, so give up here and let the outbox retry on its own horizon.
      if (hinted > 15_000) {
        console.warn(`[memory] ${label}: relayer asked for ${Math.round(hinted / 1000)}s — not retrying inline`);
        throw err;
      }

      // Jitter: synchronised retries from several surfaces are how a wobble
      // becomes a thundering herd.
      const backoff = Math.min(Math.max(hinted, 400 * 2 ** attempt), 6000) * (0.7 + Math.random() * 0.6);
      if (Date.now() + backoff > deadline) throw err;
      console.warn(
        `[memory] ${label} failed (${err.status ?? "network"}), retry ${attempt + 1}/${retries} in ${Math.round(backoff)}ms`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/**
 * Which namespaces are known to hold anything.
 *
 * Retrying an empty recall is the right call for a namespace that has data (the
 * relayer drops results at random — see docs/memwal-feedback.md). It is dead
 * wrong for one that is genuinely empty: an unseeded knowledge base made every
 * single turn pay five attempts and seconds of backoff to retrieve nothing, and
 * that wasted load is what pushed the relayer into rate-limiting us.
 *
 * So: retry on empty only where we have evidence something is stored.
 */
const NS_INDEX = process.env.NS_INDEX_PATH ?? new URL("../../known-namespaces.json", import.meta.url).pathname;

const knownNonEmpty = new Set(
  (() => {
    try {
      return JSON.parse(readFileSync(NS_INDEX, "utf8"));
    } catch {
      return [];
    }
  })(),
);

// The set has to survive a restart. Held only in memory, every cold start left
// each person's first recall unprotected — and an unprotected empty is
// indistinguishable from "we have never met", so a returning user got greeted
// as a stranger about 40% of the time.
let indexDirty = false;
const rememberNamespace = (namespace) => {
  knownEmpty.delete(namespace);
  if (!knownNonEmpty.has(namespace)) {
    knownNonEmpty.add(namespace);
    indexDirty = true;
  }
};
setInterval(() => {
  if (!indexDirty) return;
  indexDirty = false;
  writeFile(NS_INDEX, JSON.stringify([...knownNonEmpty])).catch((err) =>
    console.error("[memory] could not save namespace index:", err.message),
  );
}, 5000).unref();

export const markNonEmpty = rememberNamespace;

/**
 * Namespaces that answered empty recently, so we stop paying to ask.
 *
 * An unseeded knowledge base and a person with no opt-out record are both
 * genuinely empty, and every turn was spending a network round trip plus a
 * retry on each of them. Short TTL so a namespace that gains content starts
 * being read again on its own; a confirmed write clears it immediately.
 */
const EMPTY_TTL_MS = 60_000;
const knownEmpty = new Map();
const isKnownEmpty = (ns) => (knownEmpty.get(ns) ?? 0) > Date.now();

/**
 * Write one fact verbatim and wait for its blob. Use for facts we have already
 * decided on (identity links, explicit "remember that ..." requests).
 *
 * A timeout here is an UNKNOWN, not a failure. The relayer regularly takes
 * longer than the SDK's 60s default to reach `done`, and the write usually
 * lands anyway — a caller that retries on timeout writes the same memory to
 * Walrus twice, paying twice and poisoning every later recall with duplicates.
 * So we wait longer, then hand the job_id back as `pending` and let the caller
 * resolve it later. See docs/memwal-feedback.md.
 */
export async function rememberFact(namespace, text, { idempotencyKey, timeoutMs = 180_000 } = {}) {
  // The relayer rejects a reused key carrying different content (409), and the
  // rejection is permanent — a caller whose payload varies by so much as a
  // timestamp locks itself out of that key forever. Binding the key to a hash
  // of the content makes that impossible: identical writes dedupe, changed
  // writes get a new key automatically.
  const key = idempotencyKey
    ? `${idempotencyKey}:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`
    : undefined;

  let res;
  try {
    res = await withRetry(
      "remember",
      () => memwal.rememberAndWait(text, namespace, { idempotencyKey: key, timeoutMs }),
      { retries: 2, budgetMs: 240_000 },
    );
  } catch (err) {
    if (err?.status === 504 && err?.jobId) {
      return { blobId: null, pending: true, jobId: err.jobId, namespace };
    }
    throw err;
  }
  const blobId = res?.blob_id;
  if (!blobId) {
    throw new Error(
      `remember produced no blob_id for ${namespace}: ${JSON.stringify(res)}`,
    );
  }
  rememberNamespace(namespace);
  count("blobs");
  return { blobId, id: res.id, namespace, pending: false };
}

/**
 * Write many facts in one request.
 *
 * The relayer batches these server-side — embedding and encrypting in parallel,
 * then collapsing what would be N separate transaction sets into roughly one.
 * Writing twenty statements one at a time meant twenty mainnet round trips at
 * 30-120s each; this is a single call.
 *
 * Max 20 per call, so callers hand over whatever they have and it is split.
 */
export async function rememberMany(namespace, texts, { timeoutMs = 300_000, retries = 2 } = {}) {
  const out = [];

  for (let i = 0; i < texts.length; i += 20) {
    let pending = texts.slice(i, i + 20).filter(Boolean);
    const landed = new Map();

    for (let attempt = 0; pending.length && attempt <= retries; attempt++) {
      if (attempt) {
        // The relayer's encryption backend goes away for seconds at a time.
        // withRetry never sees this because the bulk call RESOLVES with the
        // failures inside it rather than throwing, so the retry lives here.
        const wait = 4000 * 2 ** (attempt - 1);
        console.warn(`[memory] rememberBulk: retrying ${pending.length} item(s) in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      }

      const batch = pending.map((text) => ({ text, namespace }));
      const res = await withRetry(
        "rememberBulk",
        () => memwal.rememberBulkAndWait(batch, { timeoutMs }),
        { retries: 1, budgetMs: timeoutMs + 60_000 },
      );

      const stillFailing = [];
      const reasons = [];
      for (const [n, r] of (res?.results ?? []).entries()) {
        const text = batch[n]?.text;
        if (r.blob_id) {
          rememberNamespace(r.namespace ?? namespace);
          count("blobs");
          landed.set(text, { text, blobId: r.blob_id, status: r.status });
        } else {
          stillFailing.push(text);
          reasons.push(`${r.status ?? "no blob"}${r.error ? ": " + r.error : ""}`);
        }
      }

      if (stillFailing.length) {
        console.warn(
          `[memory] rememberBulk: ${stillFailing.length}/${batch.length} did not land — ` +
            [...new Set(reasons)].join("; ").slice(0, 180),
        );
      }
      pending = stillFailing;
    }

    for (const text of texts.slice(i, i + 20).filter(Boolean)) {
      out.push(landed.get(text) ?? { text, blobId: null, status: "failed" });
    }
  }
  return out;
}

/** Resolve a write that timed out earlier. Never re-sends the text. */
export async function resolvePending(jobId) {
  const s = await withRetry("status", () => memwal.getRememberStatus(jobId));
  return {
    status: s.status,
    blobId: s.blob_id ?? null,
    namespace: s.namespace,
    settled: ["done", "failed", "not_found"].includes(s.status),
  };
}

/**
 * Hand a conversation turn to the relayer's extractor and let it decide which
 * discrete facts are worth keeping. Extraction runs server-side in the TEE, so
 * the raw turn is never shipped to the chat model just to be summarised, and
 * we pay no model tokens for it.
 *
 * `occurredAt` anchors relative references ("next Friday") to real dates before
 * the fact is embedded. We always know when a chat turn happened, so we always
 * pass it.
 */
export async function learnFrom(namespace, text, occurredAt = new Date()) {
  const startedAt = Date.now();
  // Without a retry a relayer wobble loses the memory for good, and the user is
  // never told, because the reply has already shipped.
  const res = await withRetry(
    "analyze",
    () => memwal.analyzeAndWait(text, { namespace, occurredAt }),
    { retries: 3, budgetMs: 300_000 }, // background work; nobody is waiting
  );
  const stored = (res?.results ?? []).filter((r) => r.status === "done");
  for (const r of stored) rememberNamespace(r.namespace);
  observe("writeMs", Date.now() - startedAt);
  count("blobs", stored.length);
  count("facts", (res?.facts ?? []).length);
  return {
    facts: res?.facts ?? [],
    stored: stored.map((r) => ({ blobId: r.blob_id, namespace: r.namespace })),
    failed: (res?.results ?? []).filter((r) => r.status !== "done"),
  };
}

/**
 * Semantic recall, budgeted so a long memory never crowds the model's context.
 *
 * Pure relevance ranking, deliberately. `scoringWeights` only re-ranks the
 * candidates the vector search already returned — it cannot widen the window —
 * so a recency weight buys very little and costs a footgun. Newest-wins reads
 * go through `readLatest` and its server-side `sort: "recent"` instead.
 */
export async function recall(namespace, query, { limit = 8, maxTokens = 700, retries = 3 } = {}) {
  // The relayer intermittently answers a matching query with an empty result
  // set — measured at 6 empties in 14 identical calls against a namespace
  // holding 13 memories. An empty recall is indistinguishable from a namespace
  // that genuinely has nothing in it, so nothing upstream can detect this: the
  // bot simply forgets you, at random, and acts like it never knew you.
  //
  // So we retry on empty — but ONLY for a namespace we have seen hold data.
  // Retrying a genuinely empty one is wasted load, and enough of it gets the
  // whole account rate-limited.
  // Asking a namespace we just found empty costs a round trip to learn nothing.
  if (isKnownEmpty(namespace)) return [];

  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await withRetry(
      "recall",
      () =>
        memwal.recall({
          query,
          namespace,
          limit,
          maxTokens,
          truncationStrategy: "high-relevance-only",
        }),
      { budgetMs: 15_000 },
    );
    const hits = res?.results ?? [];
    if (hits.length) {
      rememberNamespace(namespace);
      observe("recallMs", Date.now() - started);
      return hits;
    }
    // Nothing came back. Retry only if we know this namespace has content —
    // otherwise an empty answer is simply the truth, and retrying it is pure
    // wasted load.
    // A namespace we have never seen hold data still gets one retry: it may
    // simply be the first read since a deploy. Known ones get the full budget.
    const allowed = knownNonEmpty.has(namespace) ? retries : 1;
    if (attempt >= allowed) {
      observe("recallMs", Date.now() - started);
      if (!knownNonEmpty.has(namespace)) knownEmpty.set(namespace, Date.now() + EMPTY_TTL_MS);
      return hits;
    }
    count("recallEmptyRetries");
    // Empties cluster in time rather than arriving independently, so back off.
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt * (0.7 + Math.random() * 0.6)));
  }
}

/**
 * Rehydrate a namespace's index from its on-chain blobs. This returns COUNTS,
 * not text — it is a sync call, not a listing. There is no "list everything in
 * a namespace" read in the API, which is why exact lookups below are done by
 * deriving a dedicated namespace rather than by scanning one.
 */
export async function syncNamespace(namespace, limit = 100) {
  return withRetry("restore", () => memwal.restore(namespace, limit));
}

/**
 * EVERY record in a key-like namespace, newest first.
 *
 * Append-only storage means a key namespace accumulates versions. Reading only
 * the newest is right for a value; for identity it is dangerous, because a
 * duplicate record silently hides the one holding all the memories. Callers
 * that can heal a duplicate should read them all.
 *
 * `patience` is high on purpose: an empty answer here is indistinguishable from
 * "this account is new", and acting on a false empty costs a user their
 * history. We would much rather pay extra reads than get this wrong.
 */
export async function readRecords(namespace, { patience = 6 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await withRetry(
      "readRecords",
      () => memwal.recall({ query: "record", namespace, limit: 20 }),
      { budgetMs: 20_000 },
    );
    const hits = res?.results ?? [];
    if (hits.length) {
      rememberNamespace(namespace);
      return [...hits].sort(
        (a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0),
      );
    }
    if (attempt >= patience) return [];
    await new Promise((r) => setTimeout(r, 250 * 2 ** Math.min(attempt, 4) * (0.7 + Math.random() * 0.6)));
  }
}

/**
 * Read the CURRENT record from a key-like namespace.
 *
 * Walrus Memory is append-only: there is no update and no delete, so writing a
 * new version of a record leaves the old one in place. The current value is
 * therefore the NEWEST record, chosen explicitly on `created_at` — never the
 * best-ranked one. Relevance ranking will happily return a superseded record,
 * which for an identity lookup means a link silently fails to take effect.
 *
 * Exactness comes from the namespace being a deterministic function of the key,
 * not from the vector match. Returns null when nothing is stored yet.
 */
export async function readLatest(namespace) {
  if (isKnownEmpty(namespace)) return null;
  // `sort: "recent"` over-fetches candidates server-side and orders them by
  // write-time. Sorting client-side instead would be wrong: a superseding
  // record that fell outside the cosine window could never be recovered,
  // however carefully we re-ranked what did come back.
  for (let attempt = 0; ; attempt++) {
    const res = await withRetry("readLatest", () =>
      memwal.recall({ query: "record", namespace, limit: 1, sort: "recent" }),
    );
    const hit = res?.results?.[0]?.text;
    if (hit) {
      knownNonEmpty.add(namespace);
      return hit;
    }
    if (attempt >= (knownNonEmpty.has(namespace) ? 3 : 1)) {
      if (!knownNonEmpty.has(namespace)) knownEmpty.set(namespace, Date.now() + EMPTY_TTL_MS);
      return null;
    }
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt * (0.7 + Math.random() * 0.6)));
  }
}

/**
 * Collapse memories that say the same thing.
 *
 * The extractor has no view of what is already stored, so telling it the same
 * thing twice in different words writes two blobs: "You're thinking of
 * rewriting the frontend in React" and "You're considering rewriting the
 * frontend in React" are separate memories that both come back on every recall.
 * Storage is append-only, so they cannot be removed — but they can be collapsed
 * on the way out, which is what stops them crowding the context window and the
 * panel. Keeps the newest wording of each fact.
 */
const normalise = (t) =>
  String(t).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

export function dedupe(hits) {
  const kept = [];
  for (const hit of [...hits].sort(
    (a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0),
  )) {
    const norm = normalise(hit.text);
    if (!norm) continue;
    // One contains the other, or they are the same sentence reworded slightly.
    const dup = kept.some((k) => {
      const other = normalise(k.text);
      if (other === norm || other.includes(norm) || norm.includes(other)) return true;
      const a = new Set(norm.split(" "));
      const b = new Set(other.split(" "));
      const shared = [...a].filter((w) => b.has(w)).length;
      // 0.7 rather than something stricter, because keeping the NEWEST wording
      // means a loose match doubles as supersession: "Node 20" superseded by
      // "Node 22" collapses to the current one instead of recalling both.
      return shared / Math.max(a.size, b.size) >= 0.7;
    });
    if (!dup) kept.push(hit);
  }
  return kept;
}

export async function health() {
  return memwal.health();
}

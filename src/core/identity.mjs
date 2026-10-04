/**
 * Identity across surfaces.
 *
 * A person is a stable id. Each surface account (a Discord user, a Telegram
 * user, a web session) maps to exactly one person, and several accounts can map
 * to the same person once linked — that is what makes this bot remember you
 * when you move from Discord to Telegram.
 *
 * WHERE STATE LIVES
 *
 * Identity is durable, so it lives on Walrus. But a Walrus write takes 30–120s
 * to confirm on mainnet, and making the user wait on it turned `/link` into a
 * five-minute stare at a typing indicator. So this module is write-behind:
 *
 *   - The in-process cache is authoritative for the running server. Linking
 *     updates it immediately and the user is answered in about a second.
 *   - Walrus is the durable copy, written in the background with retries. It is
 *     what the cache is rebuilt from after a restart.
 *
 * Link codes are NOT stored on Walrus at all. They are ten-minute, single-use
 * secrets that only this server needs to understand; putting them on permanent
 * decentralised storage was slow and pointless — a permanent blob for a secret
 * that expires before lunch.
 *
 * Records are superseded, not edited: Walrus Memory is append-only, so a link
 * writes a NEW identity record and the newest one wins (`sort: "recent"`).
 *
 * Lookups are EXACT. The namespace is derived from the surface account id, so a
 * hit belongs to that account by construction. Identity is never resolved by
 * semantic similarity — "close enough" would hand one user another's memories.
 */

import { randomUUID, randomInt } from "node:crypto";
import { readLatest, readRecords, identityNs, personNs, profileNs, markNonEmpty } from "./memory.mjs";
import { enqueueRemember } from "./outbox.mjs";

const LINK_CODE_TTL_MS = 10 * 60 * 1000;

// Unambiguous alphabet: no O/0, no I/1 — these get read aloud and retyped.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const parse = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const accountKey = (surface, surfaceUserId) => `${surface}:${surfaceUserId}`;

/** surface account -> { personId, mergedFrom[] }. Authoritative while the process runs. */
const identities = new Map();
/** code -> { personId, surface, expiresAt }. Never leaves this process. */
const linkCodes = new Map();
/** personId -> boolean */
const optOuts = new Map();

const toPerson = (rec, isNew = false) => {
  const namespaces = [personNs(rec.personId), ...(rec.mergedFrom ?? []).map(personNs)];

  // A person who already exists has already told us things, so their memory
  // namespaces hold data. Saying so up front matters: recall only retries the
  // relayer's random empty responses for namespaces it knows are non-empty, and
  // a process that has just started knows nothing. Without this, the first
  // message after every deploy had a real chance of being met with amnesia.
  if (!isNew) for (const ns of namespaces) markNonEmpty(ns);

  return { personId: rec.personId, namespaces, mergedFrom: rec.mergedFrom ?? [], isNew };
};

/**
 * Persist a record to Walrus without making anyone wait for it. The outbox
 * retries durably, across restarts, until it lands.
 */
const persist = (label, namespace, text, opts = {}) =>
  enqueueRemember(namespace, text, { ...opts, label });

/**
 * The person for a surface account, creating one on first contact.
 * `namespaces` is every namespace this person's memories live in: their own,
 * plus any merged in by linking.
 */
export async function resolvePerson(surface, surfaceUserId, { displayName } = {}) {
  const key = accountKey(surface, surfaceUserId);
  const cached = identities.get(key);
  if (cached) return toPerson(cached);

  // Cold cache (first contact, or a restart): Walrus is the source of truth.
  //
  // Read EVERY record, not just the newest. The relayer intermittently answers
  // a matching query with an empty result set; when that happened here the bot
  // concluded "we have never met", minted a second person for an account that
  // already had one, and — because newest-wins — permanently orphaned every
  // memory under the first. That is the worst thing this system can do.
  //
  // So duplicates are healed rather than treated as fatal: the newest record is
  // the primary identity, and every other person id ever recorded for this
  // account is folded into mergedFrom, which recall already unions over. An
  // account that was split by a bad read silently knits itself back together.
  const records = (await readRecords(identityNs(surface, surfaceUserId)))
    .map((h) => parse(h.text))
    .filter((r) => r?.personId);

  if (records.length) {
    const primary = records[0].personId; // readRecords sorts newest first
    const mergedFrom = [
      ...new Set(records.flatMap((r) => [r.personId, ...(r.mergedFrom ?? [])])),
    ].filter((id) => id !== primary);

    if (records.length > 1) {
      console.warn(
        `[identity] ${surface}:${surfaceUserId} had ${records.length} identity records — healed into ${primary} + ${mergedFrom.length} merged`,
      );
    }
    const rec = { personId: primary, mergedFrom };
    identities.set(key, rec);
    noteSurface(primary, surface).catch(() => {});
    return toPerson(rec);
  }

  // Genuinely new. Answer now; persist behind the reply.
  const rec = { personId: randomUUID(), mergedFrom: [] };
  identities.set(key, rec);
  persist(
    `new person ${surface}`,
    identityNs(surface, surfaceUserId),
    // No timestamp of our own: the relayer stamps created_at, and a volatile
    // field would change the payload on every retry.
    JSON.stringify({ personId: rec.personId, surface, surfaceUserId, displayName }),
    { idempotencyKey: `id:${surface}:${surfaceUserId}` },
  );
  noteSurface(rec.personId, surface).catch(() => {});
  return toPerson(rec, true);
}

/** Issue a short-lived code the user types on another surface. Instant. */
export function issueLinkCode(personId, surface) {
  const now = Date.now();
  for (const [c, v] of linkCodes) if (v.expiresAt < now) linkCodes.delete(c);

  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  } while (linkCodes.has(code));

  linkCodes.set(code, { personId, surface, expiresAt: now + LINK_CODE_TTL_MS });
  return { code, expiresInMinutes: LINK_CODE_TTL_MS / 60000 };
}

/**
 * Redeem a code on a second surface, collapsing both accounts into one person.
 *
 * The redeeming account keeps its own memories: rather than moving blobs, the
 * identity record lists the old person under `mergedFrom` and recall unions
 * across all of them. Nothing is rewritten, so nothing can be lost in a merge.
 */
export async function redeemLinkCode(surface, surfaceUserId, rawCode) {
  const code = String(rawCode).trim().toUpperCase();
  const entry = linkCodes.get(code);
  if (!entry) return { ok: false, reason: "unknown-code" };
  if (entry.expiresAt < Date.now()) {
    linkCodes.delete(code);
    return { ok: false, reason: "expired" };
  }
  if (entry.surface === surface) return { ok: false, reason: "same-surface" };

  const current = await resolvePerson(surface, surfaceUserId);
  if (current.personId === entry.personId) {
    linkCodes.delete(code);
    return { ok: true, personId: entry.personId, alreadyLinked: true };
  }

  linkCodes.delete(code); // single use
  return { ok: true, ...(await adoptPerson(surface, surfaceUserId, entry.personId, current)) };
}

/**
 * This account is that person from now on.
 *
 * The merge half of linking, on its own, because two things need it: redeeming
 * a code, and signing in to the website by approving it in Telegram. Written
 * once so the two cannot drift, since the way they could drift is by one of
 * them dropping a `mergedFrom` and orphaning everything an account said before
 * it was linked. That bug has happened here once already and it is silent.
 *
 * Union, not migration. The ids this account used to answer to are kept so
 * every memory written under them is still reachable; nothing is rewritten and
 * nothing on Walrus is touched, because nothing on Walrus can be.
 */
export async function adoptPerson(surface, surfaceUserId, personId, known = null) {
  const current = known ?? (await resolvePerson(surface, surfaceUserId));
  if (current.personId === personId) return { ...toPerson({ personId, mergedFrom: current.mergedFrom }), alreadyLinked: true };

  const mergedFrom = [...new Set([current.personId, ...current.mergedFrom])].filter(
    (id) => id !== personId,
  );

  const rec = { personId, mergedFrom };
  identities.set(accountKey(surface, surfaceUserId), rec); // live immediately
  noteSurface(personId, surface).catch(() => {});

  persist(
    `link ${surface}`,
    identityNs(surface, surfaceUserId),
    JSON.stringify({ personId, surface, surfaceUserId, mergedFrom }),
    { idempotencyKey: `id:${surface}:${surfaceUserId}:${personId}` },
  );

  return toPerson(rec);
}

/**
 * Look up a surface account WITHOUT creating one.
 *
 * `resolvePerson` mints a person when it finds nothing, which is right for a
 * first message and wrong for a credential check: every wrong memory key would
 * otherwise "work", minting an empty person and paying for a blob to do it.
 */
export async function lookupAccount(surface, surfaceUserId) {
  const key = accountKey(surface, surfaceUserId);
  const cached = identities.get(key);
  if (cached) return toPerson(cached);

  const records = (await readRecords(identityNs(surface, surfaceUserId)))
    .map((h) => parse(h.text))
    .filter((r) => r?.personId);
  if (!records.length) return null;

  const primary = records[0].personId;
  const mergedFrom = [...new Set(records.flatMap((r) => [r.personId, ...(r.mergedFrom ?? [])]))]
    .filter((id) => id !== primary);
  const rec = { personId: primary, mergedFrom };
  identities.set(key, rec);
  return toPerson(rec);
}

/**
 * Point a second account at an existing person — how a memory key or a wallet
 * becomes another way in to the same memory. Live immediately, persisted behind.
 */
export function bindAccount(surface, surfaceUserId, personId, mergedFrom = []) {
  const rec = { personId, mergedFrom };
  noteSurface(personId, surface).catch(() => {});
  identities.set(accountKey(surface, surfaceUserId), rec);
  persist(
    `bind ${surface}:${surfaceUserId}`,
    identityNs(surface, surfaceUserId),
    JSON.stringify({ personId, surface, surfaceUserId, mergedFrom }),
    { idempotencyKey: `id:${surface}:${surfaceUserId}:${personId}` },
  );
  return toPerson(rec);
}

/** personId -> Set of surfaces, so a repeat visit costs no read and no write. */
const surfaces = new Map();

/**
 * Note that a person uses this surface, writing only when it is news.
 * Called on every resolve, so it must stay cheap for the common case.
 */
export async function noteSurface(personId, surface) {
  let known = surfaces.get(personId);
  if (!known) {
    const stored = parse(await readLatest(profileNs(personId)));
    known = new Set(stored?.surfaces ?? []);
    surfaces.set(personId, known);
  }
  if (known.has(surface)) return [...known];

  known.add(surface);
  persist(
    `profile ${personId}`,
    profileNs(personId),
    JSON.stringify({ personId, surfaces: [...known].sort() }),
    { idempotencyKey: `profile:${personId}` },
  );
  return [...known];
}

/** Which surfaces this person has connected. Cheap after the first read. */
export async function surfacesFor(personId) {
  const known = surfaces.get(personId);
  if (known) return [...known];
  const stored = parse(await readLatest(profileNs(personId)));
  const set = new Set(stored?.surfaces ?? []);
  surfaces.set(personId, set);
  return [...set];
}

const optOutNs = (personId) => `ws8::optout::${personId}`;

/**
 * Whether this person has asked us to stop recording.
 *
 * We cannot honour a delete — Walrus is append-only and the blobs persist until
 * their storage epochs lapse. What we can honour is "write nothing more", and
 * saying exactly that is more respectable than a delete button that lies.
 *
 * Checked on every turn, so it is cached; the relayer is asked once per person.
 */
export async function isOptedOut(personId) {
  if (optOuts.has(personId)) return optOuts.get(personId);
  const rec = parse(await readLatest(optOutNs(personId)));
  const value = rec?.optedOut === true;
  optOuts.set(personId, value);
  return value;
}

export function setOptOut(personId, optedOut) {
  optOuts.set(personId, optedOut);
  persist(`opt-out=${optedOut}`, optOutNs(personId), JSON.stringify({ optedOut, at: new Date().toISOString() }));
  return { optedOut };
}

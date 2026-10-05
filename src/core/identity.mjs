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
    noteSurface(primary, surface, displayName).catch(() => {});
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
  noteSurface(rec.personId, surface, displayName).catch(() => {});
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
/**
 * Keep what the app you just connected already knows about you.
 *
 * Connecting Telegram hands over a name and a handle the person has already
 * typed once, somewhere else. Not keeping them means the web greets somebody
 * who has just proved who they are with "what should I call you?", which is
 * the exact question this product exists not to ask twice.
 *
 * Written verbatim into the person's own namespace rather than through the
 * extractor, because the extractor rewrites what it is given and a name is the
 * one fact that must come back as it went in.
 *
 * The idempotency key carries the name itself. Keying it on the person alone
 * would be a one-way door: MemWal returns 409 forever for a key reused with
 * different content, so somebody changing their Telegram name would silently
 * stop being nameable (issue #1057, filed from this project).
 */
export function rememberWho(personId, { firstName, handle, surface }) {
  if (!personId || !/^[\p{L}][\p{L}\p{M}' .-]{0,40}$/u.test(String(firstName ?? "").trim())) return false;
  const name = String(firstName).trim();

  const text = handle
    ? `User's name is ${name}. They are @${handle} on ${surface}.`
    : `User's name is ${name}, from their ${surface} account.`;

  enqueueRemember(personNs(personId), text, {
    label: `name from ${surface}`,
    idempotencyKey: `who:${personId}:${surface}:${name.toLowerCase().replace(/\s+/g, "-")}`,
  });
  return true;
}

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

/** personId -> { set, accounts }, so a repeat visit costs no read and no write. */
const surfaces = new Map();

async function profileOf(personId) {
  let p = surfaces.get(personId);
  if (p) return p;
  const stored = parse(await readLatest(profileNs(personId)));
  p = { set: new Set(stored?.surfaces ?? []), accounts: { ...(stored?.accounts ?? {}) } };
  surfaces.set(personId, p);
  return p;
}

/**
 * Note that a person uses this surface, and under which account.
 *
 * The account name is the point of knowing it. "Telegram: connected" is a
 * claim somebody has to take on trust; "@dannytrillion" is something they can
 * check against the app in their hand, which is the difference between being
 * told two accounts are the same person and being shown it.
 *
 * Writes only when something is news, because this runs on every resolve.
 *
 * THE KEY CARRIES THE CONTENT, AND HAS TO
 *
 * It used to be `profile:<personId>`, fixed, while the payload grew every time
 * a surface was added. That is MemWal issue #1057, filed from this project: an
 * idempotency key reused with changed content answers 409 forever. So the first
 * write landed and every later one was rejected in silence — the record on
 * Walrus still said "web" for somebody who had since connected Telegram and
 * Discord, and it looked right only because the in-process copy was correct
 * until the next restart.
 */
export async function noteSurface(personId, surface, handle = null) {
  const p = await profileOf(personId);
  const name = handle ? String(handle).replace(/^@/, "").slice(0, 60) : null;
  const newSurface = !p.set.has(surface);
  const newHandle = !!name && p.accounts[surface] !== name;
  if (!newSurface && !newHandle) return [...p.set];

  p.set.add(surface);
  if (name) p.accounts[surface] = name;

  const body = { personId, surfaces: [...p.set].sort(), accounts: p.accounts };
  persist(
    `profile ${personId}`,
    profileNs(personId),
    JSON.stringify(body),
    { idempotencyKey: `profile:${personId}:${hash(JSON.stringify(body.surfaces) + JSON.stringify(body.accounts))}` },
  );
  return [...p.set];
}

/* Short, stable, and different whenever the content is. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** Which surfaces this person has connected. Cheap after the first read. */
export async function surfacesFor(personId) {
  return [...(await profileOf(personId)).set];
}

/** And under which account on each, for a page that wants to show it. */
export async function accountsFor(personId) {
  return { ...(await profileOf(personId)).accounts };
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

/**
 * Two ways to be yourself again on a new browser.
 *
 * The web has no durable account of its own — a fresh browser is a stranger —
 * so a person needs something they can carry. Both options below produce a web
 * surface account id, which the existing identity layer already knows how to
 * bind to a person:
 *
 *   memory key   key-<hash of five words>   nothing to install, write it down
 *   Sui wallet   sui-<address>              proven by signature, no secret to keep
 *
 * Neither is a username. A credential a person chooses is one an attacker can
 * guess, and what it guards here is everything the bot knows about them.
 */

import { createHash, randomInt, randomUUID } from "node:crypto";
import { WORDS } from "./wordlist.mjs";
import { lookupAccount, bindAccount, resolvePerson } from "./identity.mjs";

const PHRASE_WORDS = 5;

/** Same phrase always yields the same account, whatever the spacing or case. */
const normalise = (phrase) =>
  String(phrase).toLowerCase().trim().split(/[^a-z]+/).filter(Boolean).join("-");

const accountForPhrase = (phrase) =>
  "key-" + createHash("sha256").update(normalise(phrase)).digest("hex").slice(0, 24);

export const newPhrase = () =>
  Array.from({ length: PHRASE_WORDS }, () => WORDS[randomInt(WORDS.length)]).join("-");

/**
 * Issue a memory key for whoever is chatting right now.
 * The phrase is never stored — only the account id derived from it — so a leak
 * of our data does not hand anyone a working key.
 */
export async function issueMemoryKey(currentUserId) {
  const me = await resolvePerson("web", currentUserId);
  const phrase = newPhrase();
  bindAccount("web", accountForPhrase(phrase), me.personId, me.mergedFrom);
  return { phrase, personId: me.personId };
}

/**
 * Redeem a memory key. Returns the web account id to adopt, or null when the
 * phrase has never been issued — a wrong key must never mint a person.
 */
export async function redeemMemoryKey(phrase) {
  const words = normalise(phrase).split("-").filter(Boolean);
  if (words.length !== PHRASE_WORDS) return { ok: false, reason: "wrong-length" };
  if (!words.every((w) => WORDS.includes(w))) return { ok: false, reason: "unknown-word" };

  const account = accountForPhrase(phrase);
  const found = await lookupAccount("web", account);
  if (!found) return { ok: false, reason: "unknown-key" };
  return { ok: true, userId: account, personId: found.personId };
}

/* ── Sui wallet ─────────────────────────────────────────────────────────── */

const challenges = new Map(); // nonce -> { userId, expiresAt }
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function issueChallenge(currentUserId) {
  const now = Date.now();
  for (const [n, v] of challenges) if (v.expiresAt < now) challenges.delete(n);
  const nonce = randomUUID();
  challenges.set(nonce, { userId: currentUserId, expiresAt: now + CHALLENGE_TTL_MS });
  return {
    nonce,
    // What the wallet shows the person before they sign. Says plainly what it does.
    message: `Continuity — prove this wallet is yours so your memory follows it.\n\nNonce: ${nonce}`,
  };
}

export function takeChallenge(nonce) {
  const entry = challenges.get(nonce);
  if (!entry) return null;
  challenges.delete(nonce); // single use
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

/**
 * Attach a verified wallet, or adopt the person it is already attached to.
 * Both directions matter: claiming on the browser you started in, and restoring
 * on a new one.
 */
export async function attachWallet(address, fallbackUserId) {
  const account = "sui-" + String(address).toLowerCase();
  const existing = await lookupAccount("web", account);
  if (existing) return { userId: account, personId: existing.personId, restored: true };

  const me = await resolvePerson("web", fallbackUserId);
  bindAccount("web", account, me.personId, me.mergedFrom);
  return { userId: account, personId: me.personId, restored: false };
}

/**
 * The bytes, on Walrus.
 *
 * WHY THIS EXISTS
 *
 * Walrus Memory stores text. The bytes of a photo or a PDF cannot be a memory,
 * so an attachment was always two halves: a description written to Walrus,
 * which is what makes the file findable, and the bytes written to the server's
 * volume, which is what makes it openable. On a platform with an ephemeral
 * filesystem the second half does not survive a redeploy, and the result was
 * backwards — the memory outlived the file it described. The dashboard said so
 * out loud: "file no longer on this server."
 *
 * That is the hole Walrus itself fills, and it is the reason this project ends
 * up using two different parts of the same stack. The relayer stores memories
 * for us; this stores the bytes those memories point at.
 *
 * WHICH NETWORK, HONESTLY
 *
 * Memories go to Walrus mainnet, because the relayer pays for them. Raw blobs
 * do not have that luxury: writing to mainnet costs WAL and SUI from a funded
 * wallet, and the public mainnet publishers are not open. So the publisher is
 * an env var and the default is testnet, which is open and free and real —
 * blobs are erasure-coded and served by the same aggregator design. Point
 * WALRUS_PUBLISHER and WALRUS_AGGREGATOR at a funded mainnet publisher and
 * nothing else in the codebase changes.
 *
 * Saying "the files are on Walrus mainnet" while they are on testnet would be
 * the kind of small lie this project is otherwise about not telling, so the
 * network is carried alongside the blob id and shown wherever the id is.
 *
 * NOTHING HERE IS ALLOWED TO BREAK A TURN
 *
 * An upload that fails costs durability, not the reply. Every function returns
 * null rather than throwing, and the attachment path treats a Walrus blob as a
 * bonus on top of the local file, never as a prerequisite.
 */

import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";

/**
 * EVERYTHING ON WALRUS IS PUBLIC, AND I LEARNED THAT TOO LATE
 *
 * From Sui's own docs, in a caution box: "Both blob contents and their metadata
 * are public. Blob IDs, blob attributes, and the onchain blob registration are
 * all discoverable by anyone, so an attacker can enumerate and read everything
 * you store. Never store secrets or private data unencrypted."
 *
 * This file shipped doing exactly that. Somebody's lease, their lecture notes,
 * their photographs — raw on a public network, with the blob id printed on
 * their own memory page. The memories were never at risk, because the relayer
 * SEAL-encrypts those; it was the attachment bytes added on top, by me, that
 * went up in the clear.
 *
 * So bytes are sealed before they leave and opened after they come back. The
 * blob is still public and still enumerable — that is what Walrus is — but
 * what anybody enumerating it finds is ciphertext.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is AES-256-GCM with a random nonce per blob, so identical files do not
 * produce identical ciphertext and tampering fails to open rather than
 * decoding to nonsense. It closes the hole that matters: a blob id is no
 * longer a copy of the file.
 *
 * It is NOT user-sovereign. The key is the server's, so this protects against
 * a stranger reading Walrus, not against whoever runs this server. Seal is the
 * right answer for that — threshold encryption with the policy on Sui, the way
 * OnlyFins does it — and it is the next thing to build rather than something
 * to claim now.
 *
 * Old blobs stay readable. Anything without the header predates this and is
 * passed through untouched, because breaking files that are already stored to
 * fix how new ones are stored helps nobody.
 */
const MAGIC = Buffer.from("WALX1\0\0\0");           // 8 bytes, so the offsets stay round
const KEY = (() => {
  /* A dedicated secret is correct. Falling back to the model key keeps this
     working on a server that has not set one yet, and is written down here
     rather than left as a surprise: rotate OPENROUTER_API_KEY without setting
     WALRUS_ENCRYPTION_KEY and every attachment already on Walrus becomes
     unreadable. */
  const secret = process.env.WALRUS_ENCRYPTION_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
  if (!secret) return null;
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("continuity:walrus:v1"),
    Buffer.from("attachment-bytes"), 32));
})();

/** Wrap bytes so a blob id is not a copy of the file. */
function seal(plain) {
  if (!KEY) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

/** And back. Anything without the header is from before this existed. */
function unseal(stored) {
  if (!stored || stored.length < MAGIC.length || !stored.subarray(0, 8).equals(MAGIC)) return stored;
  if (!KEY) { console.error("[walrus] a sealed blob came back and there is no key to open it"); return null; }
  try {
    const d = createDecipheriv("aes-256-gcm", KEY, stored.subarray(8, 20));
    d.setAuthTag(stored.subarray(20, 36));
    return Buffer.concat([d.update(stored.subarray(36)), d.final()]);
  } catch (err) {
    console.error("[walrus] could not open a sealed blob:", err.message);
    return null;
  }
}

export const encrypting = () => KEY !== null;

const PUBLISHER = (process.env.WALRUS_PUBLISHER ?? "https://publisher.walrus-testnet.walrus.space").replace(/\/$/, "");
const AGGREGATOR = (process.env.WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space").replace(/\/$/, "");

/** Derived from the publisher rather than configured separately, so the two cannot disagree. */
export const NETWORK = process.env.WALRUS_NETWORK ?? (/testnet/.test(PUBLISHER) ? "testnet" : "mainnet");

/** How long the bytes are paid to live. Long enough to outlast the hackathon. */
const EPOCHS = Number(process.env.WALRUS_EPOCHS ?? 10);

/** Big uploads are slow and a person is waiting on the other end of this. */
const PUT_TIMEOUT = Number(process.env.WALRUS_PUT_TIMEOUT_MS ?? 45_000);
const GET_TIMEOUT = Number(process.env.WALRUS_GET_TIMEOUT_MS ?? 25_000);

export const walruscan = (blobId) =>
  `https://walruscan.com/${NETWORK}/blob/${encodeURIComponent(blobId)}`;

/**
 * Store bytes and return the id they can be read back under.
 *
 * The publisher answers one of two shapes: `newlyCreated` when it wrote the
 * blob, `alreadyCertified` when someone had already stored identical bytes.
 * The second is not a failure — Walrus is content-addressed, so two people
 * uploading the same file get the same id and the second upload costs nothing.
 * Treating it as an error would have thrown away a perfectly good blob id.
 */
export async function putBlob(bytes, { epochs = EPOCHS } = {}) {
  if (!bytes?.length) return null;
  const payload = seal(bytes);
  try {
    const res = await fetch(`${PUBLISHER}/v1/blobs?epochs=${epochs}`, {
      method: "PUT",
      body: payload,
      signal: AbortSignal.timeout(PUT_TIMEOUT),
    });
    if (!res.ok) {
      console.error(`[walrus] publisher ${res.status} for ${bytes.length} bytes`);
      return null;
    }
    const out = await res.json();
    const blobId = out?.newlyCreated?.blobObject?.blobId ?? out?.alreadyCertified?.blobId ?? null;
    if (!blobId) {
      console.error("[walrus] publisher answered without a blob id");
      return null;
    }
    return { blobId, network: NETWORK, reused: !out?.newlyCreated, bytes: bytes.length, sealed: KEY !== null };
  } catch (err) {
    console.error("[walrus] upload failed:", err.message);
    return null;
  }
}

/**
 * Read bytes back. Null only when the aggregator really cannot produce them.
 *
 * Retried, because the aggregator intermittently drops a connection outright —
 * a plain `fetch failed`, no status, retrying works immediately. Letting that
 * through would mean a person asking for their file is told it cannot be
 * fetched, on the one code path that exists so a file survives the server
 * losing it. Three attempts over about a second and a half.
 *
 * A 404 is retried too, and that is not obvious. I had it returning
 * immediately on the reasoning that the aggregator saying "I do not have this"
 * is an answer. It is not, for the case that matters most: a blob written
 * seconds ago is certified before every aggregator can serve it, so the read
 * that follows a write is exactly the read that 404s. Asking somebody to wait
 * a second is better than telling them their file does not exist.
 */
export async function getBlob(blobId) {
  if (!blobId) return null;
  let last = null;
  /* Five tries over about ten seconds. A blob is certified before every
     aggregator can serve it, and the read right after a write — the one the
     UI makes as soon as a file is attached — is the one that 404s. Measured
     at more than five seconds on testnet, so four attempts was not enough. */
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 1000));
    try {
      const res = await fetch(`${AGGREGATOR}/v1/blobs/${encodeURIComponent(blobId)}`, {
        signal: AbortSignal.timeout(GET_TIMEOUT),
      });
      if (!res.ok) { last = `status ${res.status}`; continue; }
      return unseal(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      last = err.message;
    }
  }
  console.error(`[walrus] download failed after 5 tries (${last}):`, blobId);
  return null;
}

export const config = () => ({ publisher: PUBLISHER, aggregator: AGGREGATOR, network: NETWORK, epochs: EPOCHS });

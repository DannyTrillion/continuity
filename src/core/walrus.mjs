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
  try {
    const res = await fetch(`${PUBLISHER}/v1/blobs?epochs=${epochs}`, {
      method: "PUT",
      body: bytes,
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
    return { blobId, network: NETWORK, reused: !out?.newlyCreated, bytes: bytes.length };
  } catch (err) {
    console.error("[walrus] upload failed:", err.message);
    return null;
  }
}

/** Read bytes back. Null when the aggregator cannot produce them. */
export async function getBlob(blobId) {
  if (!blobId) return null;
  try {
    const res = await fetch(`${AGGREGATOR}/v1/blobs/${encodeURIComponent(blobId)}`, {
      signal: AbortSignal.timeout(GET_TIMEOUT),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("[walrus] download failed:", err.message);
    return null;
  }
}

export const config = () => ({ publisher: PUBLISHER, aggregator: AGGREGATOR, network: NETWORK, epochs: EPOCHS });

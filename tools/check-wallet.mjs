#!/usr/bin/env node
/**
 * Signing in with a Sui wallet, including the ways it goes wrong.
 *
 *   node --env-file=.env tools/check-wallet.mjs        (needs the server on :8080)
 *
 * The flow has three outcomes and they are easy to confuse, which is exactly
 * what happened: a good signature arriving while the relayer was rate limited
 * was reported as "couldn't verify that signature", and the nonce had already
 * been spent, so the retry it invited answered "that sign-in request expired".
 * Someone signed, was told their signature was bad, and had no way forward.
 *
 * So what matters is not only that a correct signature works. It is that a
 * challenge is spent when the sign-in succeeds or the signature is genuinely
 * wrong, and at no other time.
 *
 * Costs nothing against the relayer when it is busy — which is when this
 * matters — and one identity read when it is not.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const BASE = process.env.BASE ?? "http://localhost:8080";
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  const said = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${said ? ` — ${said.replace(/\s+/g, " ").slice(0, 110)}` : ""}`);
};

const post = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const challenge = (userId) => post("/api/wallet/challenge", { userId });
const verify = (nonce, message, signature) => post("/api/wallet/verify", { nonce, message, signature });
const sign = (kp, message) => kp.signPersonalMessage(new TextEncoder().encode(message));

console.log("── it asks for something to sign");
const uid = "walletcheck-" + Date.now();
const ch = await challenge(uid);
check("a challenge is issued", ch.status === 200 && Boolean(ch.body.nonce), ch.body.nonce);
check("and the message says what signing it does",
  /prove this wallet is yours/i.test(ch.body.message ?? ""), ch.body.message?.split("\n")[0]);
check("and carries the nonce, so one signature cannot be replayed for another",
  (ch.body.message ?? "").includes(ch.body.nonce), "");

console.log("\n── a signature that is genuinely wrong");
const stranger = new Ed25519Keypair();
const ch2 = await challenge(uid);
const wrong = await sign(stranger, "a different message entirely");
const bad = await verify(ch2.body.nonce, ch2.body.message, wrong.signature);
check("is refused", bad.status === 400, bad.body.error);
check("and says so plainly", /signature/i.test(bad.body.error ?? ""), bad.body.error);
check("and spends the challenge, because that failure really is the caller's",
  (await verify(ch2.body.nonce, ch2.body.message, wrong.signature)).body.error?.includes("expired") === true);

console.log("\n── a good signature");
const kp = new Ed25519Keypair();
const ch3 = await challenge(uid);
const good = await sign(kp, ch3.body.message);
const out = await verify(ch3.body.nonce, ch3.body.message, good.signature);

if (out.status === 200) {
  check("signs in", Boolean(out.body.userId), out.body.userId);
  check("and the account is the wallet's own address",
    out.body.userId === "sui-" + kp.getPublicKey().toSuiAddress().toLowerCase(), out.body.userId);
  check("and the address comes back for the header to show", Boolean(out.body.address), out.body.address);
  check("and the challenge is spent",
    (await verify(ch3.body.nonce, ch3.body.message, good.signature)).body.error?.includes("expired") === true);
} else {
  /* The relayer was busy. That is not a failed sign-in and must not read like
     one — this is the case that was broken, so it is checked rather than
     skipped. */
  check("a busy relayer answers 503, not 400", out.status === 503, `${out.status}`);
  check("and says the signature was fine", out.body.signatureOk === true, out.body.error);
  check("and invites a retry", out.body.retryable === true, "");
  check("and does NOT spend the challenge, so the retry can work",
    (await verify(ch3.body.nonce, ch3.body.message, good.signature)).status === 503,
    "nonce survived a failure that was ours, not theirs");
}

console.log("\n── a message that is not the one we asked for");
const ch4 = await challenge(uid);
const forged = await sign(kp, "Continuity — prove this wallet is yours so your memory follows it.\n\nNonce: not-the-one");
const swapped = await verify(ch4.body.nonce, "Continuity — prove this wallet is yours so your memory follows it.\n\nNonce: not-the-one", forged.signature);
check("is refused even though the signature itself is valid", swapped.status === 400, swapped.body.error);

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);

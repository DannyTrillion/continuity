#!/usr/bin/env node
/**
 * The before/after, measured instead of remembered.
 *
 *   node tools/proof.mjs
 *
 * WHY THIS IS A TOOL AND NOT A PARAGRAPH
 *
 * The article's before/after table was a list of numbers I had typed, which is
 * the weakest kind of claim: a reader has no way to tell a measurement from a
 * flattering memory, and neither do I three days later. So every "after" in
 * that table is produced here, against the live deployment, and every row
 * comes back with the one-line command a stranger can run to get the same
 * answer without trusting me.
 *
 * The run that matters most is the encryption one. It uploads a file, then
 * fetches the blob back from the PUBLIC Walrus aggregator rather than through
 * this server, because going through our own route would prove nothing — of
 * course the thing holding the key can read it. Fetching it the way an
 * attacker would is the only version of that test worth printing.
 *
 * Nothing here is allowed to invent a number. A step that cannot be measured
 * prints as unverified and the article says so rather than guessing.
 */

const BASE = (process.env.BASE ?? "https://continuity-production-6084.up.railway.app").replace(/\/$/, "");
const AGG = (process.env.WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space").replace(/\/$/, "");

const get = async (p, ms = 30_000) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};

const post = async (p, body, ms = 90_000) => {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

const rows = [];
const row = (what, was, now, check) => rows.push({ what, was, now, check });

console.log(`\n  proving against ${BASE}\n`);

/* ── 1. the storage layer is up and the numbers are its own ────────────── */

const [stats, ledger] = await Promise.all([get("/api/stats"), get("/api/ledger")]);
const writes = ledger.writes ?? [];
const mainnet = writes.find((w) => w.blobId);

console.log(`  writes on mainnet (lifetime) : ${stats.blobsTotal}`);
console.log(`  recall p50/p95               : ${stats.metrics?.recall?.avg}ms / ${stats.metrics?.recall?.p95}ms  (n=${stats.metrics?.recall?.n})`);
console.log(`  answer p50/p95               : ${stats.metrics?.answer?.avg}ms / ${stats.metrics?.answer?.p95}ms  (n=${stats.metrics?.answer?.n})`);
console.log(`  surfaces                     : ${Object.entries(stats.surfaces ?? {}).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
console.log(`  outbox                       : ${JSON.stringify(stats.outbox)}`);
console.log(`  empty-recall retries served  : ${stats.metrics?.recallEmptyRetries ?? "?"}`);

/* ── 2. a brand new person, timed, and then asked the hard question ────── */

/* A fresh id every run. Reusing one would measure a warm identity and the
   number that matters is the cold one — the first thing a stranger sees. */
const who = `proof-${Date.now().toString(36)}`;
const say = async (text) => {
  const t = Date.now();
  const out = await post("/api/chat", { userId: who, text });
  return { ms: Date.now() - t, reply: out.reply ?? out.text ?? JSON.stringify(out).slice(0, 300) };
};

console.log(`\n  ── cold start, person ${who} ──`);
const hello = await say("Hi, I'm Priya. I've got a backend interview next Tuesday and I always fumble the Result part of STAR.");
console.log(`  first reply   ${(hello.ms / 1000).toFixed(1)}s`);
console.log(`    ${hello.reply.slice(0, 150).replace(/\n/g, " ")}`);

/* The second message is the whole point of the row. A write takes tens of
   seconds; recall only sees what has landed. So this question arrives inside
   that gap, and before the outbox was consulted it read back as amnesia. */
const back = await say("what do you know about me?");
console.log(`  second reply  ${(back.ms / 1000).toFixed(1)}s`);
console.log(`    ${back.reply.slice(0, 220).replace(/\n/g, " ")}`);

const blames = /can't read|cannot read|returning nothing|returned nothing|storage service|try again in a minute|blank this turn/i.test(back.reply);
const remembers = /priya/i.test(back.reply);
console.log(`  names them back: ${remembers}   blames storage: ${blames}`);

row("First reply, brand new person", "13.1s", `${(hello.ms / 1000).toFixed(1)}s`,
  `measured this run, cold id`);
row("Second message, inside the write gap",
  "“I can't read my memory back right now — the storage service is blank this turn.”",
  remembers ? back.reply.trim().split("\n")[0].slice(0, 190) : "(did not name them — see log)",
  remembers && !blames ? "answered from the outbox before the write landed" : "UNVERIFIED this run");

/* ── 3. the encryption claim, checked the way an attacker would ────────── */

console.log(`\n  ── sealed bytes ──`);

/* Deliberately my own throwaway text and not a real document. The point of
   this run is the header on the blob, and using somebody's actual file to
   demonstrate that their actual files are safe would be its own small joke. */
const secret = Buffer.from(
  `Continuity proof-of-encryption, written ${new Date().toISOString()}.\n` +
  `If you are reading this sentence off the Walrus aggregator, the seal failed.\n`);

const att = await post("/api/attach", {
  userId: who,
  name: "proof.txt",
  type: "text/plain",
  data: secret.toString("base64"),
});

console.log(`  uploaded      ${att.file}`);
console.log(`  walrus blob   ${att.walrusBlob ?? "(none — upload did not land)"} on ${att.walrusNetwork ?? "?"}`);

let sealed = null;
let roundTrip = null;
if (att.walrusBlob) {
  /* Straight from the public aggregator, no auth, nothing of ours in the
     path. This is the request a stranger with the blob id would make. */
  const direct = await fetch(`${AGG}/v1/blobs/${encodeURIComponent(att.walrusBlob)}`,
    { signal: AbortSignal.timeout(40_000) });
  if (direct.ok) {
    const raw = Buffer.from(await direct.arrayBuffer());
    const magic = raw.subarray(0, 5).toString("latin1");
    sealed = magic === "WALX1";
    const leaks = raw.includes(Buffer.from("proof-of-encryption"));
    console.log(`  aggregator    ${direct.status}, ${raw.length} bytes, first 5 = ${JSON.stringify(magic)}`);
    console.log(`  sealed        ${sealed}`);
    console.log(`  plaintext leaked into the blob: ${leaks}`);
    console.log(`  hexdump       ${raw.subarray(0, 24).toString("hex").replace(/(..)/g, "$1 ").trim()}`);

    /* And the other half: our own route must still hand back the original
       bytes, or "encrypted" would just mean "broken". */
    const ours = await fetch(`${BASE}/blob/${att.walrusBlob}`, { signal: AbortSignal.timeout(40_000) });
    if (ours.ok) {
      const opened = Buffer.from(await ours.arrayBuffer());
      roundTrip = opened.equals(secret);
      console.log(`  via /blob/    ${ours.status}, ${opened.length} bytes, identical to what went in: ${roundTrip}`);
    } else {
      console.log(`  via /blob/    ${ours.status} — could not read it back`);
    }
  } else {
    console.log(`  aggregator    ${direct.status} — could not fetch it`);
  }
}

/* ── 3b. the control: the same sentence, stored the old way ───────────── */

/**
 * The "before" has to be reproducible too, and it cannot be somebody's file.
 *
 * The article used to prove this row by linking the blob that actually went up
 * in the clear. It is an 87-page pharmacology lecture deck with a named
 * lecturer and their department on the title page — a real person's teaching
 * material, which I had published to a public network by accident and was then
 * citing as evidence that I had stopped doing that. Pointing readers at it to
 * demonstrate the danger was the danger.
 *
 * So the control is written here instead: the same throwaway sentence, pushed
 * straight to the publisher with no seal, exactly as the old code did. Two
 * blob ids on the same network, minutes apart, and the only difference is the
 * fix. Nobody's documents involved.
 */
const PUB = (process.env.WALRUS_PUBLISHER ?? "https://publisher.walrus-testnet.walrus.space").replace(/\/$/, "");
let control = null;
let controlPlain = null;
try {
  /* The same lifetime as the sealed blob. A control that expires first turns
     the article's one runnable comparison into half a comparison, and the
     reader is left taking the interesting half on trust. */
  const r = await fetch(`${PUB}/v1/blobs?epochs=${process.env.WALRUS_EPOCHS ?? 10}`, {
    method: "PUT", body: secret, signal: AbortSignal.timeout(60_000),
  });
  const out = await r.json();
  control = out?.newlyCreated?.blobObject?.blobId ?? out?.alreadyCertified?.blobId ?? null;
  if (control) {
    console.log(`  control blob  ${control} — unsealed, as the old code wrote it`);
    /* Retried, for the reason the article is about to explain: a blob is
       certified before every aggregator can serve it, so the read straight
       after a write is the one that 404s. The first version of this read it
       once, got the 404, and the table still printed "readable" because the
       blob id existed — the tool asserting a thing it had not checked, in a
       run whose whole purpose is not doing that. */
    for (let i = 0; i < 5 && !controlPlain; i++) {
      if (i) await new Promise((r) => setTimeout(r, i * 1500));
      const back = await fetch(`${AGG}/v1/blobs/${encodeURIComponent(control)}`,
        { signal: AbortSignal.timeout(40_000) });
      if (!back.ok) { console.log(`  attempt ${i + 1}    ${back.status}`); continue; }
      const raw = Buffer.from(await back.arrayBuffer());
      /* Readable means the sentence is there, not merely that bytes came
         back — a JSON error body is also bytes. */
      if (raw.includes(Buffer.from("proof-of-encryption"))) controlPlain = raw;
      console.log(`  reads back as ${JSON.stringify(raw.subarray(0, 48).toString("latin1"))}`);
    }
    console.log(`  plaintext readable off the public aggregator: ${controlPlain !== null}`);
  }
} catch (err) {
  console.log(`  control blob  could not be written (${err.message})`);
}

row("The same bytes, to anyone holding the blob id",
  controlPlain ? `readable — ${JSON.stringify(controlPlain.subarray(0, 42).toString("latin1"))}… off the public aggregator` : "UNVERIFIED this run",
  sealed === true ? "WALX1… — AES-256-GCM, no plaintext in the blob" : "UNVERIFIED this run",
  att.walrusBlob ? `curl ${AGG}/v1/blobs/${att.walrusBlob} | head -c 5` : "no blob this run");

row("The same file, to the person who owns it",
  "served from a disk a redeploy empties",
  roundTrip === true ? "byte-identical, fetched back out of Walrus" : "UNVERIFIED this run",
  att.walrusBlob ? `${BASE}/blob/${att.walrusBlob}` : "no blob this run");

/* ── 4. the dashboard, under the load that used to 503 it ──────────────── */

console.log(`\n  ── memory page, 12 at once ──`);
const t = Date.now();
const hits = await Promise.all(Array.from({ length: 12 }, () =>
  fetch(`${BASE}/api/memory?userId=${who}`, { signal: AbortSignal.timeout(40_000) })
    .then((r) => r.status).catch(() => "err")));
const ok = hits.filter((s) => s === 200).length;
console.log(`  ${hits.join(" ")}  → ${ok}/12 OK in ${((Date.now() - t) / 1000).toFixed(1)}s`);

row("Memory dashboard, 12 concurrent reads", "503, blank page",
  ok === 12 ? `200 × 12 in ${((Date.now() - t) / 1000).toFixed(1)}s` : `${ok}/12 — UNVERIFIED`,
  `${BASE}/api/memory?userId=${who}`);

/* ── 5. what a reader can open ─────────────────────────────────────────── */

console.log(`\n  ── open these ──`);
if (mainnet) {
  console.log(`  a memory, mainnet : https://walruscan.com/mainnet/blob/${mainnet.blobId}`);
  console.log(`                      ${mainnet.namespace} · ${mainnet.at}`);
}
if (att.walrusBlob) {
  console.log(`  sealed bytes      : https://walruscan.com/${att.walrusNetwork}/blob/${att.walrusBlob}`);
}
if (control) {
  console.log(`  the same, unsealed: https://walruscan.com/testnet/blob/${control}`);
}
console.log(`  the ledger        : ${BASE}/api/ledger`);
console.log(`  live counters     : ${BASE}/api/stats`);

/* ── the table, ready to paste ─────────────────────────────────────────── */

console.log(`\n\n  ── before / after ──\n`);
for (const r of rows) {
  console.log(`  ${r.what}`);
  console.log(`    was   ${r.was}`);
  console.log(`    now   ${r.now}`);
  console.log(`    check ${r.check}\n`);
}

/* Both columns. The "before" is a measurement too — the control blob is the
   only thing standing behind the claim that this used to be readable. */
const unverified = rows.filter((r) => /UNVERIFIED/.test(r.now) || /UNVERIFIED/.test(r.was));
if (unverified.length) {
  console.log(`  ${unverified.length} row(s) did not verify this run. Do not publish those as facts.\n`);
  process.exitCode = 1;
} else {
  console.log(`  all ${rows.length} rows verified against ${BASE}\n`);
}

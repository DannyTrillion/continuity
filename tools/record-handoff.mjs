#!/usr/bin/env node
/**
 * Record one real cross-app handoff, for the landing page to replay.
 *
 *   node --env-file=.env tools/record-handoff.mjs
 *
 * WHAT IS REAL AND WHAT IS NOT
 *
 * The memory is real: every turn goes through `respond()` — the exact function
 * the Telegram and Discord adapters call — and every fact it extracts is
 * written to Walrus mainnet through the outbox, with its blob id captured the
 * moment the write settles. The link codes are real codes, redeemed the real
 * way. What is scripted is only the transport: a function call stands in for
 * a phone. The recording carries the real timestamps, so the replay can keep
 * the order and the rhythm without having to keep the two-minute waits.
 *
 * Writes to src/web/assets/handoff.json, which the landing page reads.
 *
 * Runs with its own outbox and index files so it never fights a dev server
 * over the ones in the repo root.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = process.env.RECORD_SCRATCH ?? "/tmp/handoff-record";
process.env.OUTBOX_PATH ??= join(scratch, "outbox.json");
process.env.NS_INDEX_PATH ??= join(scratch, "known-namespaces.json");
process.env.PROVENANCE_PATH ??= join(scratch, "provenance.json");
import("node:fs").then(({ mkdirSync }) => mkdirSync(scratch, { recursive: true }));

const { respond } = await import("../src/core/session.mjs");
const { issueLinkCode, redeemLinkCode } = await import("../src/core/identity.mjs");
const { startOutbox, onSettled } = await import("../src/core/outbox.mjs");

const t0 = Date.now();
const events = [];
const log = (e) => {
  events.push({ at: Date.now() - t0, ...e });
  const tag = e.type.padEnd(8);
  console.log(`${String(Date.now() - t0).padStart(6)}ms  ${tag} ${e.surface ?? ""} ${e.text ?? e.blobId ?? e.code ?? ""}`.trimEnd());
};

/* Every settled write, with what it was for. */
const settled = [];
onSettled(({ job, ok, stored = [], facts = [], error }) => {
  if (!ok) { log({ type: "failed", surface: job.surface, text: error }); return; }
  stored.forEach((s, i) => {
    // One blob per extracted fact, in the order they came back — so the fact
    // that belongs to this blob is the one at the same position.
    const own = facts[i] ? [facts[i].text ?? facts[i]] : undefined;
    const ev = {
      type: "write",
      kind: job.kind,                        // analyze = a memory; remember = identity/plumbing
      surface: job.surface ?? null,
      blobId: s.blobId,
      namespace: s.namespace,
      label: job.label ?? null,
      facts: job.kind === "analyze" ? own : undefined,
    };
    settled.push(ev);
    log(ev);
  });
});
startOutbox();

/** Wait until an analyze write from `surface` has settled, or give up loudly. */
const waitForMemory = (surface, timeoutMs = 240_000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const seen = settled.length;
    const tick = () => {
      const hit = settled.slice(seen).find((e) => e.kind === "analyze" && e.surface === surface);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) return reject(new Error(`no memory settled from ${surface} in ${timeoutMs / 1000}s`));
      setTimeout(tick, 1500);
    };
    tick();
  });

const stamp = Date.now();
const ids = { telegram: `handoff-tg-${stamp}`, discord: `handoff-dc-${stamp}`, web: `handoff-web-${stamp}` };

async function say(surface, text) {
  log({ type: "user", surface, text });
  const started = Date.now();
  const { reply, meta } = await respond({ surface, surfaceUserId: ids[surface], displayName: "Danny", text });
  log({ type: "bot", surface, text: reply, ms: Date.now() - started, recalled: meta?.recalled?.personal ?? 0 });
  if (meta?.error) throw new Error(`turn failed on ${surface}: ${meta.error}`);
  return meta;
}

async function link(fromSurface, toSurface, personId) {
  const { code } = issueLinkCode(personId, fromSurface);
  log({ type: "code", surface: fromSurface, code });
  const r = await redeemLinkCode(toSurface, ids[toSurface], code);
  if (!r.ok) throw new Error(`link ${fromSurface}→${toSurface} failed: ${r.reason}`);
  log({ type: "linked", surface: toSurface, text: `linked to ${fromSurface}` });
}

try {
  // 1. Telegram, first contact. This is the memory the other two will read.
  const m1 = await say("telegram", "Hi — I'm Danny. I use pnpm, never npm, and I'm on Node 22 on a Mac.");
  const personId = m1.personId;
  await waitForMemory("telegram");

  // 2. Discord, linked with a real code, asking about something only Telegram was told.
  await link("telegram", "discord", personId);
  await say("discord", "quick one — which package manager do I use?");
  await waitForMemory("discord").catch((e) => log({ type: "note", text: e.message }));

  // 3. Web, linked from Discord, asking a different fact from the same first message.
  await link("discord", "web", personId);
  await say("web", "and what Node version am I on again?");
  await waitForMemory("web").catch((e) => log({ type: "note", text: e.message }));

  const out = {
    recordedAt: new Date(stamp).toISOString(),
    personId,
    how: "Recorded through the server's own respond() — the code path the Telegram and Discord adapters call — with real link codes and real Walrus writes. Only the transport is scripted.",
    events,
  };
  const dest = join(here, "..", "src", "web", "assets", "handoff.json");
  writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${dest} — ${events.length} events, ${settled.filter((e) => e.kind === "analyze").length} memory blob(s)`);
  process.exit(0);
} catch (err) {
  console.error("\nrecording failed:", err.message);
  process.exit(1);
}

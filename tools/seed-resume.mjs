#!/usr/bin/env node
/**
 * Seed a web user with a few distinct, finished conversations, so the
 * "pick it back up" capture has real rows to show. Runs with a short idle
 * window and its own outbox so it neither waits eight minutes per
 * conversation nor fights the dev server over the repo's files.
 *
 *   CONVO_IDLE_MS=4000 node --env-file=.env tools/seed-resume.mjs
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
const scratch = process.env.RECORD_SCRATCH ?? "/tmp/seed-resume";
mkdirSync(scratch, { recursive: true });
process.env.OUTBOX_PATH ??= join(scratch, "outbox.json");
process.env.NS_INDEX_PATH ??= join(scratch, "known-namespaces.json");
process.env.PROVENANCE_PATH ??= join(scratch, "provenance.json");
process.env.CONVO_IDLE_MS ??= "4000";

const { respond } = await import("../src/core/session.mjs");
const { startOutbox, onSettled } = await import("../src/core/outbox.mjs");
const { flushAll } = await import("../src/core/conversations.mjs");
let settled = 0;
onSettled(({ job, ok, error }) => { console.log(ok ? "settled" : "failed", job.kind, job.label ?? "", error ?? ""); if (ok) settled++; });
startOutbox();

const user = process.argv[2] ?? "resume-demo";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convos = [
  ["I'm Danny — I'm building a small Node app and I keep getting 403 from the Walrus publisher. Any idea?", "I'm on mainnet, using the relayer, not the raw publisher."],
  ["Planning a trip to Lisbon in November, three nights. What should I not miss?", "I like food markets and I don't drink."],
  ["Help me name a side project: it's a CLI that turns screenshots into alt text.", "Something short, one word if possible."],
  ["I've got a job interview on Thursday for a backend role. What should I prepare?", "It's Go and Postgres mostly."],
];
for (const turns of convos) {
  for (const text of turns) {
    const { reply, meta } = await respond({ surface: "web", surfaceUserId: user, displayName: "Danny", text });
    console.log("→", text.slice(0, 50), "\n←", reply.slice(0, 80).replace(/\n/g, " "), meta?.error ? `(${meta.error})` : "");
    await sleep(1500);
  }
  await sleep(Number(process.env.CONVO_IDLE_MS) + 1500); // let it close
}
await flushAll();
const t = Date.now();
while (Date.now() - t < 240_000) { await sleep(5000); if (settled >= convos.length) break; }
console.log("done, settled writes:", settled);
process.exit(0);

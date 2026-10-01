#!/usr/bin/env node
/**
 * Does it ever meet someone it knows as a stranger?
 *
 *   node --env-file=.env tools/check-known.mjs
 *
 * Runs turns with the memory layer switched off, for a person whose namespace
 * is known to hold memories, and reads the replies for the things it must
 * never say. This is the failure a rate limit produces in production; here it
 * is produced on purpose. Writes nothing.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
const scratch = "/tmp/check-known";
mkdirSync(scratch, { recursive: true });
process.env.OUTBOX_PATH = join(scratch, "outbox.json");
process.env.PROVENANCE_PATH = join(scratch, "provenance.json");
process.env.FOLLOWUPS_PATH = join(scratch, "followups.json");

const { handleTurn } = await import("../src/core/agent.mjs");
const { markNonEmpty, personNs } = await import("../src/core/memory.mjs");

const personId = "check-known-" + Date.now();
markNonEmpty(personNs(personId)); // we have read this person's memory before

const FORBIDDEN = /first (conversation|time)|never (spoken|talked|met)|no memory of (you|talking)|don'?t (carry|persist)|nothing carries over|don't have any (memory|record) of you/i;
const asks = [
  "I sent you an image of someone on the beach right?",
  "This isn't our first conversation, see",
  "what do you know about me?",
];
let bad = 0, history = [];
for (const message of asks) {
  const t = await handleTurn({ personId, namespaces: [], message, history, surface: "web", remember: false, memoryless: true });
  const hit = t.text.match(FORBIDDEN);
  console.log(`${hit ? "FAIL" : "PASS"}  “${message}”\n      → ${t.text.replace(/\s+/g, " ").slice(0, 230)}${hit ? `\n      said: “${hit[0]}”` : ""}`);
  if (hit) bad++;
  history = [...history, { role: "user", content: message }, { role: "assistant", content: t.text }];
}
console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);

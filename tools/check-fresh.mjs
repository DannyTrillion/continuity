#!/usr/bin/env node
/**
 * Does a brand-new person stay known one message later?
 *
 *   node --env-file=.env tools/check-fresh.mjs
 *
 * The read-after-write window is the worst bug this project can have, because
 * it hits the exact path a first-time visitor walks. Someone says who they
 * are; the facts go to the outbox; a write takes 14 seconds on average against
 * mainnet. Their next message is almost always "so what do you know about me?"
 * — and if recall is the only thing consulted, it has landed nothing yet and
 * the bot greets them as a stranger. A chatbot that remembers, forgetting
 * someone between two consecutive messages.
 *
 * So: enqueue a write without letting it drain, then take a turn, and read the
 * reply for amnesia. Nothing is sent to the relayer — the outbox is pointed at
 * a scratch file and never flushed, which is exactly the state being tested.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const scratch = "/tmp/check-fresh-" + Date.now();
mkdirSync(scratch, { recursive: true });
process.env.OUTBOX_PATH = join(scratch, "outbox.json");
process.env.PROVENANCE_PATH = join(scratch, "provenance.json");
process.env.FOLLOWUPS_PATH = join(scratch, "followups.json");
process.env.NS_INDEX_PATH = join(scratch, "known-namespaces.json");

const { handleTurn } = await import("../src/core/agent.mjs");
const { personNs } = await import("../src/core/memory.mjs");
const { enqueueAnalyze } = await import("../src/core/outbox.mjs");

const personId = "check-fresh-" + Date.now();
const ns = personNs(personId);

/* Turn one, as the outbox holds it a second after the reply went out. This is
   the person's own sentence, which is what an analyze job carries. */
enqueueAnalyze(
  ns,
  "I'm Priya. I'm prepping for a backend interview next Tuesday and I always forget the Result part of STAR answers.",
  new Date(),
  "web",
);

/* What it must never say to someone who introduced themselves one message ago. */
const AMNESIA = /first (conversation|time)|never (spoken|talked|met)|don'?t (know|have) (anything|any ?thing|much) about you|no memory of you|nothing (stored|on you)|haven'?t (met|spoken)|storage service is blank|can'?t read my memory/i;

const checks = [
  { ask: "what do you know about me?", want: /priya|interview|star|result/i, wantLabel: "their name, the interview or STAR" },
  { ask: "remind me what I said I keep forgetting", want: /result/i, wantLabel: "the Result part" },
];

let bad = 0;
let history = [];
for (const { ask, want, wantLabel } of checks) {
  const t = await handleTurn({
    personId,
    namespaces: [ns],
    message: ask,
    history,
    surface: "web",
    remember: false,
  });
  const said = t.text.replace(/\s+/g, " ").trim();
  const amnesia = said.match(AMNESIA);
  const recalled = want.test(said);

  if (amnesia) {
    console.log(`FAIL  “${ask}”\n      → ${said.slice(0, 230)}\n      said: “${amnesia[0]}”`);
    bad++;
  } else if (!recalled) {
    console.log(`FAIL  “${ask}”\n      → ${said.slice(0, 230)}\n      never mentioned ${wantLabel}`);
    bad++;
  } else {
    console.log(`PASS  “${ask}”\n      → ${said.slice(0, 230)}`);
  }
  console.log(`      known=${t.known} memoryless=${t.memoryless}`);
  history = [...history, { role: "user", content: ask }, { role: "assistant", content: t.text }];
}

console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);

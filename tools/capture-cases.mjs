#!/usr/bin/env node
/**
 * Capture real cross-surface conversations for the use-cases page.
 *
 * Every exchange here is produced by the actual bot against Walrus mainnet —
 * nothing is written by hand. A page about memory illustrated with invented
 * dialogue would be worth nothing, and these transcripts double as evidence
 * that the thing works.
 *
 *   node tools/capture-cases.mjs            # all cases
 *   node tools/capture-cases.mjs learning   # one case
 *
 * Writes src/web/cases.json. Costs WAL: each case stores real memories.
 */

import { writeFileSync } from "node:fs";
import { respond } from "../src/core/session.mjs";
import { lookupAccount, issueLinkCode, redeemLinkCode } from "../src/core/identity.mjs";
import { startOutbox, outboxStats } from "../src/core/outbox.mjs";

startOutbox();

const CASES = [
  {
    id: "learning",
    title: "Learning something hard",
    situation:
      "A tutor that knows what you already struggled with doesn't re-explain the easy parts, or assume you got the hard one.",
    first: { surface: "web", turns: [
      "I'm learning Rust and the borrow checker keeps rejecting my code. Ownership I think I get, but lifetimes make no sense to me.",
      "yeah the 'a syntax is where I lose it",
    ]},
    later: { surface: "telegram", turns: ["can you explain lifetimes to me?"] },
  },
  {
    id: "unstuck",
    title: "Getting unstuck",
    situation:
      "You describe your setup once. Nobody asks you to describe it again, on any app, ever.",
    first: { surface: "web", turns: [
      "I'm on Node 22 on a Mac, deploying a Walrus Site with site-builder, and the publisher returns 403 every time.",
      "I already tried a different publisher URL and regenerated my wallet, no luck",
    ]},
    later: { surface: "discord", turns: ["ok I'm back. what should I try next?"] },
  },
  {
    id: "helpdesk",
    title: "A community helpdesk",
    situation:
      "Someone asks in Discord what they already asked you in a DM last week. Same person, same thread.",
    first: { surface: "telegram", turns: [
      "we're a small team of 4, we store user uploads on Walrus and we're trying to work out storage costs before we commit",
      "about 50GB to start, growing maybe 10GB a month",
    ]},
    later: { surface: "discord", turns: ["what would our storage cost look like over a year?"] },
  },
  {
    id: "longrunning",
    title: "Something you said months ago",
    situation:
      "A preference you mentioned once doesn't quietly expire because a session ended.",
    first: { surface: "web", turns: [
      "quick thing about me: I'm vegetarian and I really don't like coriander",
      "also I cook for two most nights",
    ]},
    later: { surface: "telegram", turns: ["what should I make for dinner tonight?"] },
  },
];

const drain = async (limit = 240000) => {
  const t0 = Date.now();
  while (outboxStats().pending && Date.now() - t0 < limit) await new Promise((r) => setTimeout(r, 3000));
};

const wanted = process.argv.slice(2);
const chosen = wanted.length ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
const out = [];

for (const spec of chosen) {
  const stamp = Date.now();
  const firstId = `${spec.first.surface}-case-${spec.id}-${stamp}`;
  const laterId = `${spec.later.surface}-case-${spec.id}-${stamp}`;
  console.log(`\n── ${spec.title}`);

  const first = [];
  for (const text of spec.first.turns) {
    const r = await respond({ surface: spec.first.surface, surfaceUserId: firstId, text });
    console.log(`   [${spec.first.surface}] ${text.slice(0, 60)}…`);
    first.push({ you: text, bot: r.reply });
  }

  console.log("   waiting for memories to land on Walrus…");
  await drain();

  // Link the two accounts the same way a person would.
  const me = await lookupAccount(spec.first.surface, firstId);
  const { code } = issueLinkCode(me.personId, spec.first.surface);
  const linked = await redeemLinkCode(spec.later.surface, laterId, code);
  if (!linked.ok) {
    console.log(`   link failed: ${linked.reason}`);
    continue;
  }

  const later = [];
  let carried = [];
  for (const text of spec.later.turns) {
    const r = await respond({ surface: spec.later.surface, surfaceUserId: laterId, text });
    console.log(`   [${spec.later.surface}] ${text} → recalled ${r.meta?.recalled?.personal ?? 0}`);
    later.push({ you: text, bot: r.reply });
    carried = (r.meta?.trace ?? []).map((t) => t.text);
  }

  out.push({
    id: spec.id,
    title: spec.title,
    situation: spec.situation,
    firstSurface: spec.first.surface,
    laterSurface: spec.later.surface,
    first,
    later,
    carried,
    capturedAt: new Date().toISOString(),
  });
  writeFileSync("src/web/cases.json", JSON.stringify(out, null, 2));
}

console.log(`\ncaptured ${out.length} case(s) → src/web/cases.json`);
process.exit(0);

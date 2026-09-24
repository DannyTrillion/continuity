#!/usr/bin/env node
/**
 * Give each demo persona its handbook.
 *
 *   node tools/seed-personas.mjs [registrar|tutor|...]
 *
 * Small and hand-written, unlike the Walrus knowledge base which is extracted
 * from the real docs. These are a couple of dozen facts each, so they go in one
 * batched call per persona and cost very little of the hourly budget.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PERSONAS } from "../src/core/personas.mjs";
import { rememberMany, recall } from "../src/core/memory.mjs";

const LEDGER = new URL("../kb-seeded.json", import.meta.url).pathname;
const seeded = new Set(existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : []);
const keyOf = (t) => createHash("sha256").update(t).digest("hex").slice(0, 16);

const wanted = process.argv.slice(2);
const chosen = Object.values(PERSONAS).filter(
  (p) => p.seed.length && (!wanted.length || wanted.includes(p.id)),
);

for (const persona of chosen) {
  const fresh = persona.seed.filter((t) => !seeded.has(keyOf(`${persona.kb}|${t}`)));
  if (!fresh.length) {
    console.log(`${persona.name}: already seeded`);
    continue;
  }

  // Ask the namespace before writing, so a lost ledger doesn't double the cost.
  const probe = await recall(persona.kb, fresh[0], { limit: 3 });
  if (probe.some((h) => h.text.trim() === fresh[0].trim())) {
    for (const t of persona.seed) seeded.add(keyOf(`${persona.kb}|${t}`));
    writeFileSync(LEDGER, JSON.stringify([...seeded]));
    console.log(`${persona.name}: already present in ${persona.kb}`);
    continue;
  }

  const written = await rememberMany(persona.kb, fresh);
  const ok = written.filter((w) => w.blobId);
  for (const w of ok) seeded.add(keyOf(`${persona.kb}|${w.text}`));
  writeFileSync(LEDGER, JSON.stringify([...seeded]));
  console.log(`${persona.name}: ${ok.length}/${fresh.length} stored in ${persona.kb}`);
  if (ok.length < fresh.length) console.log("   some did not land — run again to fill the gap");
}

console.log("\nspot check:");
for (const persona of chosen) {
  const q = persona.id === "registrar" ? "deadline to drop a module" : "what is a closure";
  const hits = await recall(persona.kb, q, { limit: 2 });
  console.log(`  ${persona.name} · "${q}" → ${hits.length}`);
  for (const h of hits) console.log(`     • ${h.text.slice(0, 92)}`);
}
process.exit(0);

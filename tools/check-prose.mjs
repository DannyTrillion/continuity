#!/usr/bin/env node
/**
 * Does this read like a person wrote it?
 *
 *   node tools/check-prose.mjs press/inkray-not-a-support-bot.md
 *
 * The tells that give AI text away are countable, so they get counted rather
 * than eyeballed. A human reading their own draft for the fourth time stops
 * seeing "crucial"; grep does not.
 *
 * Prose only. Code fences, blob ids and curl commands are excluded, because
 * a hex dump has no sentence rhythm and flagging its line lengths would bury
 * the findings that matter under noise.
 *
 * It reports; it does not rewrite. Every flag is a judgement call — "robust"
 * is banned as a vague compliment and fine about an engineering property —
 * and a script that silently swapped words would wreck sentences it does not
 * understand.
 */

import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) { console.error("usage: node tools/check-prose.mjs <file.md>"); process.exit(1); }

const raw = await readFile(file, "utf8");

/* Strip what is not prose: fenced blocks, inline code, links' URLs (but keep
   their visible labels), and image markup. */
const prose = raw
  .replace(/```[\s\S]*?```/g, "")
  .replace(/`[^`]*`/g, "")
  .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/^#{1,4}\s/gm, "");

const WORDS = `delve|delves|delving|tapestry|testament|vibrant|pivotal|crucial|intricate|intricacies|
meticulous|meticulously|bolster|bolstered|garner|garnered|underscore|underscores|interplay|multifaceted|
foster|fostering|utilize|commence|facilitate|encompass|encompassing|paramount|groundbreaking|cutting-edge|
game-changing|game-changer|transformative|revolutionise|revolutionize|seamless|seamlessly|endeavour|endeavor|
aforementioned|harnessing|spearheading|showcasing|unprecedented|remarkable|stunning|profound|synergy|synergies|
pain points|thought leader|moving forward|circle back|rest assured`.replace(/\s+/g, "");

const PHRASES = [
  /it's worth noting/i, /it is worth noting/i, /it's important to note/i,
  /let's dive/i, /let's delve/i, /at its core/i, /in the realm of/i, /when it comes to/i,
  /a testament to/i, /not just .{1,30}, but/i, /this is where .{1,25} comes in/i,
  /whether you're a/i, /at the end of the day/i, /the bottom line is/i,
  /here's the thing/i, /without further ado/i, /in a nutshell/i, /buckle up/i,
  /next level/i, /unlock the/i, /empower/i, /elevate your/i, /streamline/i,
  /supercharge/i, /bridge the gap/i, /move the needle/i, /in conclusion/i,
  /^overall,/im, /^moreover,/im, /^furthermore,/im, /^additionally,/im,
  /^interestingly,/im, /^notably,/im, /^importantly,/im, /^indeed,/im, /^certainly,/im,
];

const findings = [];
const flag = (kind, detail) => findings.push({ kind, detail });

for (const m of prose.matchAll(new RegExp(`\\b(${WORDS})\\b`, "gi"))) {
  flag("banned word", `"${m[1]}"`);
}
for (const re of PHRASES) {
  const m = prose.match(re);
  if (m) flag("banned phrase", `"${m[0].trim()}"`);
}

/* Em dashes: at most one per 500 words. The most cited tell there is. */
const words = prose.split(/\s+/).filter(Boolean).length;
const dashes = (prose.match(/—/g) ?? []).length;
const dashBudget = Math.max(1, Math.round(words / 500));
if (dashes > dashBudget) flag("em dashes", `${dashes} in ${words} words (budget ${dashBudget})`);

const bangs = (prose.match(/!/g) ?? []).length;
if (bangs > Math.max(1, Math.round(words / 1000))) flag("exclamations", `${bangs}`);

/* Sentence rhythm. Three consecutive sentences of near-identical length is
   the single most measurable signal, so it is measured. */
const sentences = prose.replace(/\n+/g, " ").split(/(?<=[.?!])\s+/)
  .map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2);
const lens = sentences.map((s) => s.split(/\s+/).length);
let runs = 0;
for (let i = 2; i < lens.length; i++) {
  const [a, b, c] = [lens[i - 2], lens[i - 1], lens[i]];
  if (Math.max(a, b, c) - Math.min(a, b, c) <= 2) {
    runs++;
    if (runs <= 3) flag("uniform rhythm", `${a}/${b}/${c} words: "${sentences[i - 2].slice(0, 58)}…"`);
  }
}

const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
const sd = Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / (lens.length || 1));

console.log(`\n  ${file}`);
console.log(`  ${words} words of prose · ${sentences.length} sentences`);
console.log(`  mean ${avg.toFixed(1)} words, spread ${sd.toFixed(1)}, shortest ${Math.min(...lens)}, longest ${Math.max(...lens)}`);
console.log(`  em dashes ${dashes} (budget ${dashBudget}) · semicolons ${(prose.match(/;/g) ?? []).length}`);
console.log(`  contractions ${(prose.match(/\b\w+'(s|t|re|ve|ll|d|m)\b/gi) ?? []).length}`);

if (!findings.length) { console.log("\n  nothing flagged\n"); process.exit(0); }

console.log("");
const byKind = {};
for (const f of findings) (byKind[f.kind] ??= []).push(f.detail);
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`  ${kind} (${list.length})`);
  for (const d of [...new Set(list)].slice(0, 12)) console.log(`    · ${d}`);
}
console.log("");

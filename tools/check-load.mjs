#!/usr/bin/env node
/**
 * What the product costs when more than one person is using it.
 *
 *   node tools/check-load.mjs
 *
 * The relayer allows a thousand weighted requests an hour for the whole
 * account, shared by the web chat, Telegram and Discord. Everything here is
 * about not spending them on answers already known or already being fetched —
 * because the way that failure surfaces is a real person being told, on a
 * different app, that their memory cannot be read.
 */
import { recall } from "../src/core/memory.mjs";
import { readFileSync } from "node:fs";

let bad = 0;
const t = (n, ok, d="") => { ok ? console.log(`PASS  ${n}${d?" — "+d:""}`) : (bad++, console.log(`FAIL  ${n} ${d}`)); };

// Two identical reads fired together must become one request.
const ns = "ws8::person::dedupe-probe-" + Date.now();
const a = recall(ns, "anything", { limit: 2, maxTokens: 100 });
const b = recall(ns, "anything", { limit: 2, maxTokens: 100 });
t("two identical reads at once share one promise", a === b);
await Promise.all([a, b]).catch(() => {});
const c = recall(ns, "anything", { limit: 2, maxTokens: 100 });
t("and a later read is a fresh one, never a cached answer", c !== a);
await c.catch(() => {});

// A different query is a different question.
const d1 = recall(ns, "anything", { limit: 2, maxTokens: 100 });
const d2 = recall(ns, "something else", { limit: 2, maxTokens: 100 });
t("different questions are not conflated", d1 !== d2);
await Promise.all([d1, d2]).catch(() => {});

// The skip must be keyed on isNew, never on "looks empty".
const agent = readFileSync("src/core/agent.mjs", "utf8");
t("a first message skips the reads whose answer is already known",
  /isNew \? Promise\.resolve\(namespaces\.map\(\(\) => \[\]\)\)/.test(agent));
t("and the profile read too", /isNew \? Promise\.resolve\(\[\]\)/.test(agent));
t("keyed on being newly minted, not on a namespace looking empty",
  !/hasMemories\([^)]*\)\s*\?\s*Promise\.resolve/.test(agent));
const sess = readFileSync("src/core/session.mjs", "utf8");
t("and the turn is actually told", /isNew: who\.isNew === true/.test(sess));

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);

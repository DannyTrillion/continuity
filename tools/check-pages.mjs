#!/usr/bin/env node
/**
 * Syntax-check the JavaScript inside the HTML pages.
 *
 * The pages are edited by string replacement, which can silently detach a
 * keyword from what it modifies — an `async` left behind by an insertion turned
 * the whole chat script into a parse error, and the only symptom was panels
 * that quietly never populated. `node --check` cannot see inline script, so
 * this pulls it out and parses it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pages = ["index.html", "chat.html", "use-cases.html", "demo.html", "memory.html", "history.html"];
let failed = 0;

for (const page of pages) {
  const html = readFileSync(join(here, "..", "src", "web", page), "utf8");
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  blocks.forEach((m, i) => {
    try {
      // Wrapped so top-level await inside the page parses the way it does live.
      new Function(`return (async () => {\n${m[1]}\n})`);
      console.log(`PASS  ${page} script#${i + 1} (${m[1].length} chars)`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${page} script#${i + 1}: ${err.message}`);
    }
  });
}
process.exit(failed ? 1 : 0);

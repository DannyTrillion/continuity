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
const pages = ["index.html", "chat.html", "use-cases.html", "demo.html", "memory.html", "history.html", "app.html", "docs.html", "welcome.html"];
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
/**
 * A class that sets `display` overrides the `hidden` attribute, so an element
 * toggled with `hidden` stays visible. This has now bitten three times — the
 * surface chips, and the attachment tray twice — so it gets a check.
 */
for (const page of pages) {
  const html = readFileSync(join(here, "..", "src", "web", page), "utf8");
  for (const m of html.matchAll(/<[a-z]+[^>]*class="([^"]+)"[^>]*\shidden[\s>]/gi)) {
    for (const cls of m[1].split(/\s+/).filter(Boolean)) {
      const setsDisplay = new RegExp(`\\.${cls}\\s*\\{[^}]*display\\s*:\\s*(flex|grid|block|inline-flex|inline-block)`).test(html);
      const guarded = html.includes(`.${cls}[hidden]`);
      if (setsDisplay && !guarded) {
        failed++;
        console.error(`FAIL  ${page}: .${cls} sets display and is toggled with [hidden] — add .${cls}[hidden]{display:none}`);
      }
    }
  }
}

/**
 * One logo, one app shell, on every page.
 *
 * The docs page wore a flat CSS dot instead of the mark and the modes page had
 * no mark at all, which nobody notices on the page they are editing and
 * everybody notices clicking between two. Both are a function of the markup,
 * so both are checkable without a browser: the mark is the two arcs, and the
 * app shell is the manifest plus the metas that make an installed copy stop
 * looking like a tab.
 */
const ALL = [...pages, "modes.html"];
const ARCS = /M16 5a11 11 0 0 1 11 11/;       // the opening arc of the mark
const SHELL = [
  'name="theme-color"',
  'name="apple-mobile-web-app-capable"',
  'name="apple-mobile-web-app-status-bar-style"',
  'rel="manifest"',
  'rel="apple-touch-icon"',
  "viewport-fit=cover",
];

for (const page of ALL) {
  const html = readFileSync(join(here, "..", "src", "web", page), "utf8");

  // app.html fuses four pages and keeps one nav, so one mark is correct there.
  const brand = html.match(/<a class="brand"[\s\S]*?<\/a>/);
  if (!brand) {
    failed++;
    console.error(`FAIL  ${page}: no brand link`);
  } else if (!ARCS.test(brand[0])) {
    failed++;
    console.error(`FAIL  ${page}: the brand is not the Continuity mark — missing the arcs`);
  } else if (!/<b>Continuity<\/b>/.test(brand[0])) {
    failed++;
    console.error(`FAIL  ${page}: the mark is there but the wordmark is not`);
  } else {
    console.log(`PASS  ${page} wears the mark and the wordmark`);
  }

  const missing = SHELL.filter((tag) => !html.includes(tag));
  if (missing.length) {
    failed++;
    console.error(`FAIL  ${page}: not installable as an app — missing ${missing.join(", ")}`);
  } else {
    console.log(`PASS  ${page} installs as an app, not a tab`);
  }

  // A plain `100vh` is 100px too tall on a phone with browser chrome: the
  // bottom of the page sits under it and the layout looks cut off.
  for (const m of html.matchAll(/min-height:\s*100vh|height:\s*100vh/g)) {
    // Allowed only as the line before a dvh fallback on the same declaration.
    const near = html.slice(m.index, m.index + 60);
    if (!near.includes("dvh")) {
      failed++;
      console.error(`FAIL  ${page}: ${m[0]} with no 100dvh fallback beside it`);
    }
  }
}

process.exit(failed ? 1 : 0);

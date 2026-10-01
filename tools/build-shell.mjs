#!/usr/bin/env node
/**
 * Fuse chat, memory, modes and history into one document: src/web/app.html.
 *
 *   node tools/build-shell.mjs
 *
 * WHY THIS EXISTS
 *
 * The three sections were three HTML documents, so moving between them was a
 * full page load — the header torn down and rebuilt, every script re-run, a
 * few seconds of empty panel while Walrus was read again. No amount of easing
 * fixes that, because the page really is being destroyed each time.
 *
 * As one document the header is simply never replaced. Switching sections
 * shows one panel and hides another, which is instant by construction.
 *
 * WHY IT IS GENERATED RATHER THAN HAND-MERGED
 *
 * The three pages were written independently and collide everywhere: `.list`,
 * `.sub`, `.foot` and `.empty` mean different things in each, and `--r` is
 * 24px in chat and 20px in the other two. Merging by hand means finding every
 * one of those by eye. Here each panel's CSS is mechanically scoped under its
 * own id and its variables re-pointed at that panel, so the pages stay
 * independently editable — and independently viewable, which is worth a lot
 * when something breaks and you need to know which half owns the bug.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web");
const read = (f) => readFileSync(join(WEB, f), "utf8");

/* ── CSS scoping ──────────────────────────────────────────────────────── */

/** Rules the shell owns. A panel repeating them would fight it. */
const GLOBAL = /^(\*|html|body|\.ground|\.bloom|\.grain)([,\s{:]|$)/;

/**
 * Walk a stylesheet rule by rule, matching braces rather than guessing with a
 * regular expression — selectors contain braces-adjacent syntax often enough
 * that guessing corrupts the output silently.
 */
function rules(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    out.push({ prelude, body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

/** Strip comments so a commented-out selector cannot be scoped as live CSS. */
const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function scope(css, sel, tag) {
  const keyframes = new Set();
  for (const r of rules(decomment(css))) {
    const m = r.prelude.match(/^@(?:-webkit-)?keyframes\s+([\w-]+)$/);
    if (m) keyframes.add(m[1]);
  }

  const rename = (text) => {
    let out = text;
    for (const name of keyframes) {
      // Both the @keyframes declaration and every animation shorthand that
      // names it. Two panels each defining `rise` differently is otherwise a
      // silent, baffling bug where one section animates like the other.
      out = out.replace(new RegExp(`(@(?:-webkit-)?keyframes\\s+)${name}\\b`, "g"), `$1${name}-${tag}`);
      out = out.replace(new RegExp(`(animation(?:-name)?\\s*:[^;}]*?\\b)${name}\\b`, "g"), `$1${name}-${tag}`);
    }
    return out;
  };

  const walk = (text) =>
    rules(text)
      .map(({ prelude, body }) => {
        if (/^@(?:-webkit-)?keyframes/.test(prelude)) return `${prelude}{${body}}`;
        if (/^@(media|supports|container)/.test(prelude)) return `${prelude}{${walk(body)}}`;
        if (/^@/.test(prelude)) return `${prelude}{${body}}`;

        // Variables defined on :root would win globally and redefine chat's
        // palette. Pinned to the panel they apply only inside it, and the
        // cascade does the rest.
        if (prelude === ":root" || prelude === "html" && /--/.test(body)) return `${sel}{${body}}`;
        if (GLOBAL.test(prelude)) return ""; // the shell already provides it

        const scoped = prelude
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => `${sel} ${s}`)
          .join(",");
        return `${scoped}{${body}}`;
      })
      .filter(Boolean)
      .join("\n");

  return rename(walk(decomment(css)));
}

/* ── pulling the pieces out ───────────────────────────────────────────── */

const between = (text, startMark, endMark, { inclusive = false } = {}) => {
  const a = text.indexOf(startMark);
  if (a === -1) throw new Error(`missing ${startMark}`);
  const b = text.indexOf(endMark, a + startMark.length);
  if (b === -1) throw new Error(`missing ${endMark} after ${startMark}`);
  return inclusive ? text.slice(a, b + endMark.length) : text.slice(a + startMark.length, b);
};

const styleOf = (html) => between(html, "<style>", "</style>");
const lastScriptOf = (html) => {
  const at = html.lastIndexOf("<script>");
  return html.slice(at + "<script>".length, html.indexOf("</script>", at));
};

const chat = read("chat.html");
const memory = read("memory.html");
const history = read("history.html");
const modes = read("modes.html");

/* The part of a panel page that is actually the panel: everything inside its
   wrapper except the nav, which the shell now owns once. */
function panelBody(html) {
  // Keep the page's own wrapper — its scoped CSS targets it, and it carries
  // the reading width. Only the nav comes out, because the shell owns one now.
  const wrap = between(html, '<div class="wrap">', "\n</div>", { inclusive: true });
  const navStart = wrap.indexOf('<nav class="top">');
  const navEnd = wrap.lastIndexOf("</nav>") + "</nav>".length;
  if (navStart === -1) throw new Error("no nav to remove");
  return (wrap.slice(0, navStart) + wrap.slice(navEnd)).trim();
}

const head = between(chat, "<head>", "<style>").replace(/\s*$/, "");
const header = between(chat, '<header class="top">', "</header>", { inclusive: true });
const chatPanel = between(chat, '<div class="layout">', "\n  </div>", { inclusive: true });
const modals = between(chat, "</div>\n</div>\n", '<script src="https://cdnjs');

const built = `<!doctype html>
<html lang="en" data-page="app">
<head>
${head}
  <style>
${styleOf(chat)}

/* ══ memory, scoped ══════════════════════════════════════════════════════
   Generated by tools/build-shell.mjs from memory.html. Edit that file. */
${scope(styleOf(memory), "#p-memory", "mem")}

/* ══ history, scoped ═════════════════════════════════════════════════════
   Generated by tools/build-shell.mjs from history.html. Edit that file. */
${scope(styleOf(history), "#p-history", "hist")}

/* ══ modes, scoped ═══════════════════════════════════════════════════════
   Generated by tools/build-shell.mjs from modes.html. Edit that file. */
${scope(styleOf(modes), "#p-modes", "mode")}
  </style>
  <link rel="stylesheet" href="/assets/motion.css">
  <script>addEventListener("pagereveal",(e)=>{
    if (!e.viewTransition) return;
    document.documentElement.classList.add("vt-in");
    /* Arrived from the button that borrowed this panel's name, so style the
       morph rather than the ordinary cross-fade. Read once and cleared: a
       later visit by any other route looks normal. */
    try {
      if (sessionStorage.getItem("vt.hero")) {
        document.documentElement.dataset.vt = "hero";
        sessionStorage.removeItem("vt.hero");
      }
    } catch { /* no store, no stamp */ }
  });</script>
  <link rel="stylesheet" href="/assets/shell.css">
  <!-- Hold the first frame until the router has run. This document is ~115KB
       with its scripts at the bottom, and the browser painted it partway
       through parsing: a view transition then snapshotted a half-built page —
       the chat panel every time, even when the address said /memory — and the
       real section appeared a few hundred milliseconds later. That was the
       blink. With render blocked until #shell-ready, the old page stays on
       screen until the new one is complete, and the cross-fade goes straight
       from one finished section to the next. -->
  <link rel="expect" href="#shell-ready" blocking="render">
</head>
<body>
<div class="ground"></div><div class="bloom"></div><div class="grain"></div>
<div class="app">

  ${header}

  <section class="panel" id="p-chat" data-panel="chat">
    ${chatPanel}
  </section>

  <section class="panel" id="p-memory" data-panel="memory" hidden>
    ${panelBody(memory)}
  </section>

  <section class="panel" id="p-modes" data-panel="modes" hidden>
    ${panelBody(modes)}
  </section>

  <section class="panel" id="p-history" data-panel="history" hidden>
    ${panelBody(history)}
  </section>

</div>

${modals.trim()}

<a class="docs-fab" href="/docs" aria-label="Docs" title="Docs">
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M4 3.5h5.2c1 0 1.8.8 1.8 1.8V16.5c0-.9-.8-1.6-1.8-1.6H4V3.5zM16 3.5h-5.2c-1 0-1.8.8-1.8 1.8V16.5c0-.9.8-1.6 1.8-1.6H16V3.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>
</a>

<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script src="/assets/app.js"></script>
<script src="/assets/router.js"></script>
<span id="shell-ready" hidden></span>

<script>
/* ── chat ── verbatim from chat.html ── */
${lastScriptOf(chat)}
</script>

<script>
/* ── memory ── from memory.html, deferred until the panel is first opened ── */
PANELS.memory = (() => {
${lastScriptOf(memory).replace(/\n\s*load\(\);[\s\S]*$/, "")}
  return { open: load };
})();
</script>

<script>
/* ── history ── from history.html, deferred until the panel is first opened ── */
PANELS.history = (() => {
${lastScriptOf(history).replace(/\n\s*start\(\);[\s\S]*$/, "")}
  return { open: start };
})();
</script>

<script>Router.start();</script>
</body>
</html>
`;

writeFileSync(join(WEB, "app.html"), built);
console.log(`wrote src/web/app.html — ${(built.length / 1024).toFixed(1)}KB`);

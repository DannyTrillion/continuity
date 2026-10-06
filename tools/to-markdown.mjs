#!/usr/bin/env node
/**
 * The articles, as Markdown somebody can paste into an editor.
 *
 *   node tools/to-markdown.mjs <in.html> <out.md>
 *
 * WHY THIS IS A SCRIPT
 *
 * Inkray and Medium will not take a styled HTML page, so the pieces have to
 * exist twice. Writing the second copy by hand creates two sources of truth,
 * and the one nobody is looking at goes stale: fix a number in the HTML on
 * Tuesday and the Markdown still carries the old one on Thursday, in public,
 * under your name. So the Markdown is derived, every time, from the page.
 *
 * It is a converter for THESE pages, not a general one. The block vocabulary
 * is small and known — receipts, the capability grid, the stat band, bug
 * cards, pull quotes — and each becomes the nearest honest Markdown rather
 * than a div soup. A receipt is a heading plus a two-item list plus a fenced
 * block, because that is what a receipt is once you take the borders away.
 *
 * What it deliberately does NOT do is pretend the video came along. A <video>
 * becomes a visible marker, so the gap is impossible to miss at paste time
 * rather than discovered by a reader.
 */

import { readFile, writeFile } from "node:fs/promises";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node tools/to-markdown.mjs <in.html> <out.md>");
  process.exit(1);
}

const html = await readFile(inPath, "utf8");

/* Only the entities these pages actually contain. A half-remembered table of
   two hundred is more likely to be wrong than a list of the four I verified. */
const unescape = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&"); // last, or it double-decodes the others

/**
 * Strip tags from a fragment, keeping the text.
 *
 * A <br> becomes a space rather than nothing. Dropping it outright welded the
 * stat band's own labels together — "writes onWalrus mainnet" — because the
 * line break was doing the spacing that the markup never wrote out.
 */
const strip = (s) => unescape(String(s ?? "")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/**
 * Inline HTML to inline Markdown.
 *
 * Links first: a link's own text may contain <code>, and converting the inner
 * tags first would leave backticks inside the bracket where they belong, but
 * converting links first keeps the href intact while the label is processed.
 */
function inline(s) {
  let t = String(s ?? "");
  t = t.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, label) => `[${inline(label).trim()}](${href})`);
  t = t.replace(/<code>([\s\S]*?)<\/code>/gi, (_, c) => `\`${strip(c)}\``);
  t = t.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_, __, c) => `**${inline(c).trim()}**`);
  t = t.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, (_, __, c) => `*${inline(c).trim()}*`);
  t = t.replace(/<br\s*\/?>/gi, " ");
  t = t.replace(/<[^>]+>/g, "");
  return unescape(t).replace(/[ \t]+/g, " ").replace(/ +([,.;:!?])/g, "$1");
}

const para = (s) => inline(s).trim();

/** A fenced block, with the colour spans thrown away but the text kept. */
const fence = (body) => {
  const text = unescape(String(body).replace(/<[^>]+>/g, ""))
    .replace(/^\n+/, "").replace(/\s+$/, "");
  return "```\n" + text + "\n```";
};

const out = [];
const push = (s) => { if (s !== null && s !== undefined && String(s).trim()) out.push(String(s)); };

/**
 * The inner HTML of the div that opens at `openIdx`, counting nesting.
 *
 * Written after a non-greedy `([\\s\\S]*?)</div>\\s*</div>` silently truncated
 * every receipt at the end of its `.pair`, dropping the `.verify` block — the
 * runnable command, which is the only reason a receipt exists. The output
 * looked plausible: heading, both sides, and an empty code fence. An article
 * whose argument is "run it yourself" would have published with nothing to
 * run, and the empty fence is exactly the kind of thing the eye skips.
 *
 * The other containers happened to survive that regex because of how their
 * children are indented, which is not a property worth depending on.
 */
function balanced(src, openIdx) {
  const tag = /<div\b/g;
  const close = /<\/div>/g;
  let i = src.indexOf(">", openIdx) + 1;
  const start = i;
  let depth = 1;
  while (depth > 0 && i < src.length) {
    tag.lastIndex = i; close.lastIndex = i;
    const o = tag.exec(src);
    const c = close.exec(src);
    if (!c) return { inner: src.slice(start), end: src.length };
    if (o && o.index < c.index) { depth++; i = o.index + 4; }
    else { depth--; i = c.index + 6; if (depth === 0) return { inner: src.slice(start, c.index), end: i }; }
  }
  return { inner: src.slice(start), end: i };
}

/**
 * Lift the nestable containers out before the main walk.
 *
 * Each becomes a marker the block regex can match without backtracking into
 * its children, and its real content is kept aside. Document order survives
 * because the marker sits exactly where the container was.
 */
const held = { receipt: [], does: [], band: [], bug: [] };
function lift(src, cls) {
  let s = src;
  for (;;) {
    const at = s.indexOf(`<div class="${cls}">`);
    if (at < 0) return s;
    const { inner, end } = balanced(s, at);
    held[cls].push(inner);
    s = `${s.slice(0, at)}<x-${cls} i="${held[cls].length - 1}"></x-${cls}>${s.slice(end)}`;
  }
}

/* ── the header, which lives outside <main> ──────────────────────────────── */

const kicker = html.match(/<p class="kicker">([\s\S]*?)<\/p>/)?.[1];
const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1];
const stand = html.match(/<p class="standfirst">([\s\S]*?)<\/p>/)?.[1];
const byline = [...html.matchAll(/<p class="byline">([\s\S]*?)<\/p>/g)]
  .flatMap((m) => [...m[1].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((x) => strip(x[1])));

if (h1) push(`# ${para(h1)}`);
if (stand) push(`**${para(stand)}**`);
if (kicker) push(`*${strip(kicker)}*${byline.length ? ` · ${byline.join(" · ")}` : ""}`);
push("![Cover: three dark monoliths with one unbroken line of amber light running through all three](continuity-cover.jpg)");
push("---");

/**
 * Walk the document in order.
 *
 * One regex with alternatives rather than a pass per block type, because the
 * order blocks appear in IS the article and matching them separately would
 * reassemble it in the order of my alternation instead.
 */
const BLOCK = new RegExp([
  /<h2>([\s\S]*?)<\/h2>/.source,
  /<h3[^>]*>([\s\S]*?)<\/h3>/.source,
  /<x-receipt i="(\d+)"><\/x-receipt>/.source,
  /<x-does i="(\d+)"><\/x-does>/.source,
  /<x-band i="(\d+)"><\/x-band>/.source,
  /<x-bug i="(\d+)"><\/x-bug>/.source,
  /<div class="warn">([\s\S]*?)<\/div>/.source,
  /<blockquote>([\s\S]*?)<\/blockquote>/.source,
  /<pre>([\s\S]*?)<\/pre>/.source,
  /<figcaption>([\s\S]*?)<\/figcaption>/.source,
  /<ul>([\s\S]*?)<\/ul>/.source,
  /<video\b([\s\S]*?)<\/video>/.source,
  /<img\b([^>]*)>/.source,
  /<p class="pull"[^>]*>([\s\S]*?)<\/p>/.source,
  /<p class="lede">([\s\S]*?)<\/p>/.source,
  /<p>([\s\S]*?)<\/p>/.source,
  /<a class="cta"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.source,
].join("|"), "g");

/* Everything above the first </header> is the title block, already emitted. */
let body = html.slice(html.indexOf("</header>") + 1);
for (const cls of ["receipt", "does", "band", "bug"]) body = lift(body, cls);

const seenCover = /class="cover"/.test(html);
for (const m of body.matchAll(BLOCK)) {
  const [whole] = m;
  const g = m.slice(1);

  if (/^<h2>/.test(whole)) { push(`## ${para(g[0])}`); continue; }
  if (/^<h3/.test(whole) && !/class="bug"/.test(whole)) { push(`### ${para(g[1])}`); continue; }

  /* A receipt: the claim, the two sides, then the thing you can run. */
  if (/^<x-receipt/.test(whole)) {
    const inner = held.receipt[Number(g[2])];
    const what = inner.match(/<div class="what">([\s\S]*?)<\/div>/)?.[1];
    const pairs = [...inner.matchAll(/<span class="tag">([\s\S]*?)<\/span><span class="(was|now)">([\s\S]*?)<\/span>/g)];
    const verify = inner.match(/<div class="verify">([\s\S]*?)<\/div>/)?.[1] ?? "";
    push(`**${strip(what)}**`);
    for (const p of pairs) push(`- **${strip(p[1])}** — ${para(p[3])}`);
    const label = verify.match(/<b>([\s\S]*?)<\/b>/)?.[1];
    const rest = verify.replace(/<b>[\s\S]*?<\/b>/, "");
    /* The prose that precedes a command, if any, reads as a sentence and
       should not be swept into the code fence with it. */
    /* The label introduces the command, so it goes above it. In the page it
       is a styled caption sitting inside the box; emitted after the fence it
       reads as a trailing comment on something already shown. */
    if (label) push(`*${strip(label)}:*`);
    const firstCmd = rest.search(/\$ |GET |00000000:/);
    if (firstCmd > 0) {
      const lead = strip(rest.slice(0, firstCmd));
      if (lead) push(para(lead));
      push(fence(rest.slice(firstCmd)));
    } else {
      push(fence(rest));
    }
    continue;
  }

  /* The capability grid: each cell is a small titled paragraph. */
  if (/^<x-does/.test(whole)) {
    for (const cell of held.does[Number(g[3])].matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)) {
      push(`**${para(cell[1])}** — ${para(cell[2])}`);
    }
    continue;
  }

  /* The stat band, as one line rather than four orphaned numbers. */
  if (/^<x-band/.test(whole)) {
    const stats = [...held.band[Number(g[4])].matchAll(/<span class="n">([\s\S]*?)<\/span><span class="k">([\s\S]*?)<\/span>/g)]
      .map((s) => `**${strip(s[1])}** ${strip(s[2])}`);
    push(stats.join(" · "));
    continue;
  }

  if (/^<x-bug/.test(whole)) {
    const inner = held.bug[Number(g[5])];
    const head = inner.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? "";
    push(`### ${para(head)}`);
    /* The 14-call sequence is a picture made of divs; as text it is the
       numbers themselves, which is all it ever said. */
    /* The sequence sits BETWEEN two paragraphs and says what the first one
       promises — "fourteen identical calls, 800ms apart:" then the calls.
       Emitting every paragraph and appending it afterwards put the evidence
       after the sentence interpreting it, which reads as a non sequitur. */
    const seqAt = inner.indexOf('<div class="seq">');
    const [before, after] = seqAt < 0
      ? [inner, ""]
      : [inner.slice(0, seqAt), inner.slice(balanced(inner, seqAt).end)];
    for (const p of before.matchAll(/<p>([\s\S]*?)<\/p>/g)) push(para(p[1]));
    if (seqAt >= 0) {
      const cells = [...balanced(inner, seqAt).inner
        .matchAll(/<div class="cell (hit|miss)">(\d+)<\/div>/g)].map((c) => c[2]);
      if (cells.length) push(fence(cells.join("  ")));
    }
    for (const p of after.matchAll(/<p>([\s\S]*?)<\/p>/g)) push(para(p[1]));
    continue;
  }

  if (/^<div class="warn">/.test(whole)) {
    const inner = g[6];
    for (const p of inner.matchAll(/<p>([\s\S]*?)<\/p>/g)) push(`> ${para(p[1])}`);
    const src = inner.match(/<span class="src">([\s\S]*?)<\/span>/)?.[1];
    if (src) push(`> \n> — *${strip(src)}*`);
    continue;
  }

  if (/^<blockquote>/.test(whole)) {
    push(strip(g[7]).split("\n").map((l) => `> ${l}`).join("\n"));
    continue;
  }

  if (/^<pre>/.test(whole)) { push(fence(g[8])); continue; }
  if (/^<figcaption>/.test(whole)) { push(`*${para(g[9])}*`); continue; }

  if (/^<ul>/.test(whole)) {
    for (const li of g[10].matchAll(/<li>([\s\S]*?)<\/li>/g)) push(`- ${para(li[1])}`);
    continue;
  }

  /* Deliberately loud. The video does not survive a paste and the writer has
     to upload it; a quiet omission is how a published piece ends up
     referencing a film that is not there. */
  if (/^<video/.test(whole)) {
    push("> **[UPLOAD THE VIDEO HERE — `clips/out/continuity-demo-1080p.mp4`, 76s]**");
    continue;
  }

  if (/^<img/.test(whole)) {
    const attrs = g[12] ?? "";
    const src = attrs.match(/src="([^"]+)"/)?.[1] ?? "";
    const alt = attrs.match(/alt="([^"]*)"/)?.[1] ?? "";
    /* The cover is emitted by hand at the top; skip the page's own copy. */
    if (/cover/.test(src)) continue;
    push(`![${alt}](${src.split("/").pop()})`);
    continue;
  }

  if (/^<p class="pull"/.test(whole)) { push(`> **${para(g[13])}**`); continue; }
  if (/^<p class="lede">/.test(whole)) { push(para(g[14])); continue; }
  if (/^<p>/.test(whole)) { push(para(g[15])); continue; }
  if (/^<a class="cta"/.test(whole)) { push(`**[${para(g[17])}](${g[16]})**`); continue; }
}

const md = out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
await writeFile(outPath, md);

const words = md.replace(/```[\s\S]*?```/g, "").replace(/[#*>\-[\]()]/g, "").split(/\s+/).filter(Boolean).length;
console.log(`${outPath}  ${md.length} chars, ~${words} words${seenCover ? "" : "  (no cover image found)"}`);

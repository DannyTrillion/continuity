#!/usr/bin/env node
/**
 * The article as clean semantic HTML, for pasting into a block editor.
 *
 *   node tools/to-rich.mjs press/inkray-BODY.md press/inkray-RICH.html
 *
 * WHY THIS EXISTS
 *
 * Inkray's editor took a pasted Markdown file and wrapped the whole article in
 * a single ```markdown code block. Not "failed to convert the formatting" —
 * swallowed 1,900 words whole, so the piece rendered as one grey slab of
 * literal asterisks. Pasting it as plain text instead would only trade that
 * for `**bold**` showing up as asterisks in the prose.
 *
 * Block editors built on ProseMirror and friends do understand pasted HTML:
 * an <h2> becomes a real heading node, <strong> becomes bold, <pre> becomes a
 * code block. So the reliable route into one of these editors is to render the
 * piece as plain semantic HTML, open it in a browser, select all, copy, and
 * paste that. The clipboard carries the structure and the editor rebuilds it
 * with its own blocks.
 *
 * Deliberately no CSS. Styling on the clipboard is what makes a pasted article
 * arrive with somebody else's fonts and colours baked into it, which an editor
 * then either honours or strips unpredictably. Structure only; let the
 * publication's own stylesheet do its job.
 *
 * The Markdown subset handled here is exactly the subset to-markdown.mjs
 * emits — not Markdown in general. That is why there is no parser dependency.
 */

import { readFile, writeFile } from "node:fs/promises";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node tools/to-rich.mjs <in.md> <out.html>");
  process.exit(1);
}

const md = await readFile(inPath, "utf8");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline Markdown → inline HTML, in an order that cannot eat its own output. */
function inline(s) {
  let t = esc(s);
  /* Code first: whatever is inside backticks is literal and must not then be
     scanned for asterisks. The placeholder keeps it out of the way. */
  const code = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(`<code>${c}</code>`) - 1}\u0000`);
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}

const lines = md.split("\n");
const out = [];
let i = 0;

while (i < lines.length) {
  const line = lines[i];

  if (!line.trim()) { i++; continue; }

  /* Fenced code. Taken verbatim — the curl commands in this article are the
     evidence, and a reader has to be able to copy them unchanged. */
  if (line.startsWith("```")) {
    const body = [];
    i++;
    while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
    i++;
    out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
    continue;
  }

  if (/^---+$/.test(line.trim())) { out.push("<hr>"); i++; continue; }

  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }

  /* A standalone image is a figure, not a paragraph containing an image. */
  const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
  if (img) { out.push(`<p><img src="${img[2]}" alt="${img[1]}"></p>`); i++; continue; }

  if (line.startsWith("> ")) {
    const body = [];
    while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^>\s?/, ""));
    out.push(`<blockquote><p>${inline(body.join(" ").trim())}</p></blockquote>`);
    continue;
  }

  if (/^[-*]\s+/.test(line)) {
    const items = [];
    while (i < lines.length && (/^[-*]\s+/.test(lines[i]) || !lines[i].trim())) {
      if (lines[i].trim()) items.push(lines[i].replace(/^[-*]\s+/, ""));
      else if (items.length && !/^[-*]\s+/.test(lines[i + 1] ?? "")) break;
      i++;
    }
    out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
    continue;
  }

  /* Everything else is a paragraph, which may run across several lines. */
  const para = [];
  while (i < lines.length && lines[i].trim()
    && !lines[i].startsWith("```") && !/^#{1,4}\s/.test(lines[i])
    && !lines[i].startsWith("> ") && !/^[-*]\s+/.test(lines[i])
    && !/^---+$/.test(lines[i].trim())) para.push(lines[i++]);
  out.push(`<p>${inline(para.join(" "))}</p>`);
}

/* A bare document. The <meta> is here so the browser does not guess the
   encoding and mangle the em dashes and curly quotes on the way to the
   clipboard. */
const html = `<!doctype html>
<meta charset="utf-8">
<title>Paste me</title>
<body style="max-width:46rem;margin:40px auto;padding:0 20px;font:16px/1.6 -apple-system,system-ui,sans-serif">
<p style="background:#fffbe6;border:1px solid #e8d48a;padding:12px 14px;border-radius:6px;font-size:14px">
Select everything below this box (click once in the text, then ⌘A), copy, and paste into the editor.
Do <b>not</b> use paste-as-plain-text — the formatting is the point.
</p>
<hr>
${out.join("\n\n")}
`;

await writeFile(outPath, html);
console.log(`${outPath}  ${out.length} blocks, ${html.length} chars`);

#!/usr/bin/env node
/**
 * Build the docs page from the documents that already tell the truth.
 *
 *   node tools/build-docs.mjs
 *
 * README.md and docs/memwal-feedback.md are the project's own record. A
 * hand-written docs page would drift from them within a week; generating it
 * means the docs say what the README says, including the v2 plan, every time
 * the shell is built. Writes src/web/docs.html.
 *
 * The Markdown converter is deliberately small — headings, paragraphs, lists,
 * fenced code, tables, links, bold, italic, blockquotes and rules — because
 * that is everything those two files use.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** Inline Markdown. Repo-relative links become code, since they have no page to go to. */
function inline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) =>
    /^(https?:)?\/\//.test(href) || href.startsWith("/")
      ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
      : `<code>${text}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  return s;
}

function markdown(src, { shift = 0, skipTitle = false } = {}) {
  const lines = src.replace(/\r/g, "").split("\n");
  const out = [];
  const toc = [];
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      let level = h[1].length + shift;
      const text = h[2].trim();
      if (level === 1 && skipTitle) { i++; continue; }
      level = Math.min(level, 4);
      const id = slug(text);
      if (level === 2) toc.push({ id, text });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*[-*]\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*\d+\.\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (/^\|/.test(line)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const [head, , ...body] = rows;
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>");
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }
    if (/^---+\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return { html: out.join("\n"), toc };
}

const readme = markdown(read("README.md"), { skipTitle: true });
const findings = markdown(read("docs/memwal-feedback.md"), { skipTitle: true, shift: 1 });

/* ── one card per section ────────────────────────────────────────────────
   The page is a carousel of sections rather than one long scroll, so the
   converted HTML is cut at every <h2>. Whatever comes before the first one is
   the overview. Each piece keeps its heading ids, so a link to a sub-heading
   still lands: the page finds which section holds it and opens that one. */
// Inline tags vanish, block tags become a space: otherwise "on <b>Walrus</b>."
// reads back as "on Walrus ." with a gap before the full stop.
const text = (html) => html.replace(/<pre>[\s\S]*?<\/pre>/g, " ")
  .replace(/<\/?(?:b|em|code|a|i|strong)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

function sectionsOf(html) {
  const parts = html.split(/(?=<h2 id=")/);
  const out = [];
  for (const part of parts) {
    const h = part.match(/^<h2 id="([^"]+)">([\s\S]*?)<\/h2>/);
    if (!h) { if (text(part)) out.push({ id: "overview", title: "Overview", body: part.trim() }); continue; }
    out.push({ id: h[1], title: text(h[2]), body: part.slice(h[0].length).trim() });
  }
  return out;
}

const sections = [
  ...sectionsOf(readme.html),
  {
    id: "memwal-findings",
    title: "MemWal findings",
    body: `<p>What building on Walrus Memory turned up, with reproductions. Filed as the bug-bounty part of the submission.</p>\n${findings.html}`,
  },
];

/* A line drawing per section, picked by what the section is about. */
const ICONS = [
  [/overview/, '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>'],
  [/idea/, '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.500 1-2A6 6 0 0 0 12 3z"/>'],
  [/try/, '<circle cx="12" cy="12" r="8.500"/><path d="M10 8.500l5.500 3.500-5.500 3.500z"/>'],
  [/command/, '<rect x="3" y="4.500" width="18" height="15" rx="2.500"/><path d="M7 9.500l3 2.500-3 2.500M12.500 15H17"/>'],
  [/how-memory|memory-works/, '<ellipse cx="12" cy="6" rx="7.500" ry="3"/><path d="M4.500 6v6c0 1.700 3.400 3 7.500 3s7.500-1.300 7.500-3V6M4.500 12v6c0 1.700 3.400 3 7.500 3s7.500-1.300 7.500-3v-6"/>'],
  [/layout/, '<path d="M4 5h7v6H4zM13 5h7v3h-7zM13 11h7v8h-7zM4 14h7v5H4z"/>'],
  [/shell/, '<rect x="3" y="4.500" width="18" height="15" rx="2.500"/><path d="M3 9h18M7 6.800h.01M10 6.800h.01"/>'],
  [/memory-page/, '<rect x="3.500" y="4" width="7" height="7" rx="1.500"/><rect x="13.500" y="4" width="7" height="7" rx="1.500"/><rect x="3.500" y="14" width="7" height="6" rx="1.500"/><rect x="13.500" y="14" width="7" height="6" rx="1.500"/>'],
  [/attach/, '<path d="M17.500 11l-6 6a3.500 3.500 0 0 1-5-5l6.800-6.800a2.400 2.400 0 0 1 3.400 3.400l-6.800 6.800a1.200 1.200 0 0 1-1.700-1.700l6.200-6.200"/>'],
  [/conversation/, '<path d="M4 12c0-3.600 3.600-6.500 8-6.500s8 2.900 8 6.500-3.600 6.500-8 6.500c-1 0-2-.200-2.900-.400L5 19.500l1.200-3.200C4.800 15.200 4 13.700 4 12z"/>'],
  [/time/, '<circle cx="12" cy="12" r="8.500"/><path d="M12 7v5.200l3.200 2"/>'],
  [/next|v2/, '<path d="M5 19L19 5M19 5h-8M19 5v8"/>'],
  [/running/, '<path d="M12 3v8M6.500 6.500a8 8 0 1 0 11 0"/>'],
  [/memwal|finding/, '<path d="M9 7a3 3 0 0 1 6 0M7.500 9.500h9v5a4.500 4.500 0 0 1-9 0v-5zM4 12h3.500M16.500 12H20M5 6.500l3 3M19 6.500l-3 3M5 19l3-2.500M19 19l-3-2.500M12 12v6.500"/>'],
];
const iconFor = (id) => (ICONS.find(([re]) => re.test(id)) ?? [null, '<path d="M7 3.500h7l4 4V20a.500.500 0 0 1-.500.500h-10.500A.500.500 0 0 1 6.500 20V4a.500.500 0 0 1 .500-.500zM14 3.500V8h4M9.500 12h5M9.500 15.500h5"/>'])[1]
  .replace(/(\d)\.500/g, "$1.5").replace(/\.(\d)00/g, ".$1");

const TINTS = ["#5AA9FF", "#7FE3D4", "#C7A6FF", "#FFB86B", "#FF8EB4", "#9BD0FF"];

/* What the card says when the section opens with a table or a code block
   rather than a sentence. Read straight off the table, a cover would say
   "Command What it does /link Issue a 6-character…". */
const SUMMARY = {
  "try-it": "Where to find it on the web, Telegram and Discord, and the one thing to try first: tell it something on one, ask on another.",
  commands: "Five slash commands: link an app, redeem a code, see what it remembers about you, stop recording, start again.",
  layout: "Where everything lives in the repository, file by file, and what each one is responsible for.",
  "running-it": "The environment variables it needs and the single command that starts the web chat and both bots.",
};

const cards = sections.map((s, i) => {
  const plain = text(s.body);
  const words = plain.split(" ").length;
  const firstPara = SUMMARY[s.id] ?? text((s.body.match(/<p>([\s\S]*?)<\/p>/) ?? [, plain])[1]);
  const excerpt = firstPara.length > 168 ? firstPara.slice(0, 165).replace(/\s+\S*$/, "") + "…" : firstPara;
  const parts = (s.body.match(/<h3 /g) ?? []).length;
  return {
    ...s,
    n: String(i + 1).padStart(2, "0"),
    tint: TINTS[i % TINTS.length],
    excerpt,
    mins: Math.max(1, Math.round(words / 220)),
    parts,
    icon: iconFor(s.id),
  };
});

const page = `<!doctype html>
<html lang="en" data-page="docs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Docs — Continuity</title>
<meta name="description" content="How Continuity works: one memory across the web, Telegram and Discord on Walrus mainnet — identity, recall, pictures, reliability, the MemWal findings, and the v2 plan.">
<link rel="icon" href="/assets/icon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@200;300;400;500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/motion.css">
<script>addEventListener("pagereveal",(e)=>{if(e.viewTransition)document.documentElement.classList.add("vt-in")});</script>
<style>
  :root{
    --void:#05070A; --glass:rgba(255,255,255,.055); --glass-2:rgba(255,255,255,.088);
    --edge:rgba(255,255,255,.1); --edge-2:rgba(255,255,255,.18);
    --ink:#fff; --soft:#C9D3DF; --dim:#8695A6; --faint:#5A6674;
    --live:#5AA9FF; --live-ghost:rgba(90,169,255,.13);
    --r:26px; --r-md:18px; --r-sm:13px;
    --display:'Outfit',system-ui,sans-serif; --sans:'Inter',-apple-system,system-ui,sans-serif;
    --mono:'JetBrains Mono',ui-monospace,Menlo,monospace; --ease:cubic-bezier(.22,1,.36,1);
    --card-w:clamp(270px,27vw,350px); --card-h:430px;
    color-scheme:dark;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--void);color:var(--soft);font:400 15.5px/1.7 var(--sans);-webkit-font-smoothing:antialiased;
    display:flex;flex-direction:column;min-height:100vh;overflow-x:hidden}
  a{color:var(--live);text-decoration:none}
  a:hover{text-decoration:underline;text-underline-offset:3px}
  button{font:inherit;color:inherit}
  .ground,.bloom,.grain{position:fixed;inset:0;z-index:0;pointer-events:none}
  .ground{background:url("/assets/texture.jpg") center/cover;opacity:.9}
  .bloom{background:radial-gradient(1000px 540px at 82% -14%, rgba(90,169,255,.14), transparent 62%),
    radial-gradient(760px 480px at 8% 108%, rgba(199,166,255,.09), transparent 60%)}
  .grain{opacity:.05;mix-blend-mode:overlay;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}

  .top{position:relative;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 22px}
  .brand{display:flex;align-items:center;gap:9px;font:500 17px var(--display);color:var(--ink)}
  .brand:hover{text-decoration:none;opacity:.8}
  .brand i{width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#9BD0FF 45%,#2E7ACB)}
  .tiny{font:500 10.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
  .go{display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border-radius:999px;background:#fff;color:#0A0D12;
    font:600 13px var(--sans);transition:transform .25s var(--ease)}
  .go:hover{text-decoration:none;transform:scale(1.03)}

  main{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0;padding:6px 0 10px}
  .hero{max-width:1180px;width:100%;margin:0 auto;padding:0 22px;display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap}
  .hero h1{margin:0;font:200 clamp(32px,4.4vw,52px)/1.05 var(--display);letter-spacing:-.025em;color:var(--ink)}
  .hero h1 em{font-style:normal;font-weight:400;background:linear-gradient(90deg,#fff,#C9DEFF 45%,#5AA9FF);-webkit-background-clip:text;background-clip:text;color:transparent}
  .hero p{margin:10px 0 0;max-width:58ch;color:var(--dim);font-size:14.5px;line-height:1.65}
  .ctl{display:flex;align-items:center;gap:10px}
  .count{font:500 12px var(--mono);color:var(--dim);min-width:64px;text-align:center}
  .count b{color:var(--ink);font-weight:500}
  .arrow{width:42px;height:42px;border-radius:50%;border:1px solid var(--edge-2);background:var(--glass);cursor:pointer;
    display:grid;place-items:center;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    transition:transform .25s var(--ease),background .25s var(--ease),opacity .25s var(--ease)}
  .arrow:hover{transform:scale(1.08);background:var(--glass-2)}
  .arrow:disabled{opacity:.3;cursor:default;transform:none}

  /* ── the carousel ── */
  .stage{position:relative;margin-top:26px;perspective:1400px}
  .track{display:flex;gap:22px;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;
    padding:26px max(22px, calc(50vw - var(--card-w) / 2)) 34px;scrollbar-width:none;cursor:grab;
    -webkit-overflow-scrolling:touch;transform-style:preserve-3d}
  .track::-webkit-scrollbar{display:none}
  .track.dragging{cursor:grabbing;scroll-snap-type:none}
  .track.dragging .card{pointer-events:none}

  .card{flex:none;width:var(--card-w);height:var(--card-h);scroll-snap-align:center;position:relative;padding:0;border:0;
    background:none;text-align:left;cursor:pointer;border-radius:var(--r);
    transform:rotateY(var(--ry,0deg)) scale(var(--s,1));opacity:var(--o,1);
    transition:opacity .3s var(--ease);will-change:transform}
  .card:focus-visible{outline:2px solid var(--live);outline-offset:4px}
  /* The glass itself. Three things make it read as glass and not a grey box:
     what is behind it shows through blurred, the top edge catches light, and
     a little of the section's colour is caught inside. */
  .glass{position:absolute;inset:0;border-radius:inherit;overflow:hidden;display:flex;flex-direction:column;padding:24px 24px 22px;
    background:linear-gradient(155deg,rgba(255,255,255,.13),rgba(255,255,255,.045) 38%,rgba(255,255,255,.02) 70%);
    border:1px solid rgba(255,255,255,.16);
    backdrop-filter:blur(26px) saturate(150%);-webkit-backdrop-filter:blur(26px) saturate(150%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 -1px 0 rgba(255,255,255,.04),0 34px 70px -34px rgba(0,0,0,.9);
    transition:border-color .6s var(--ease);backface-visibility:hidden}
  /* Nothing blurred is scaled on hover: that re-samples the pane every frame
     and its one-pixel highlight shimmers as a bright line. The contents move. */
  .card:hover .glass{border-color:rgba(255,255,255,.32)}
  .card h2,.card p,.card .ico{transition:transform .7s var(--ease)}
  .card:hover h2,.card:hover p{transform:translateY(-4px)}
  .card:hover .ico{transform:translateY(-4px) rotate(-4deg)}
  .glass::before{transition:opacity .9s var(--ease),transform 1.2s var(--ease)}
  .card:hover .glass::before{opacity:.5;transform:translate(-24px,20px)}
  .glass::before{content:"";position:absolute;width:240px;height:240px;right:-70px;top:-80px;border-radius:50%;
    background:radial-gradient(circle,var(--tint),transparent 68%);opacity:.34;filter:blur(8px);pointer-events:none}
  .glass::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
    background:linear-gradient(115deg,rgba(255,255,255,.16),transparent 26%,transparent 72%,rgba(255,255,255,.05))}
  .card-top{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between}
  .num{font:500 12px var(--mono);letter-spacing:.14em;color:var(--tint)}
  .ico{width:46px;height:46px;border-radius:15px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.18);
    background:linear-gradient(160deg,rgba(255,255,255,.16),rgba(255,255,255,.03));box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
  .ico svg{width:22px;height:22px;fill:none;stroke:var(--tint);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
  .card h2{position:relative;z-index:1;margin:auto 0 0;font:300 27px/1.14 var(--display);letter-spacing:-.02em;color:var(--ink)}
  .card p{position:relative;z-index:1;margin:12px 0 0;color:var(--soft);font-size:13.5px;line-height:1.6;opacity:.86;
    display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
  .card-foot{position:relative;z-index:1;display:flex;align-items:center;gap:8px;margin-top:18px;padding-top:15px;
    border-top:1px solid rgba(255,255,255,.12);font:500 11.5px var(--sans);color:var(--dim)}
  .card-foot .read{margin-left:auto;display:inline-flex;align-items:center;gap:6px;color:var(--ink)}
  .card-foot .read svg{transition:transform .6s var(--ease)}
  .card:hover .read svg{transform:translateX(6px)}
  .chip{padding:3px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.22)}

  .dots{display:flex;justify-content:center;gap:6px;margin-top:2px;padding:0 22px;flex-wrap:wrap}
  .dot{width:7px;height:7px;border-radius:999px;border:0;padding:0;background:rgba(255,255,255,.2);cursor:pointer;
    transition:width .35s var(--ease),background .35s var(--ease)}
  .dot.on{width:28px;background:rgba(255,255,255,.26);position:relative;overflow:hidden}
  /* The lit dot is also the clock: it fills over the time this card has left. */
  .dot.on::after{content:"";position:absolute;inset:0;border-radius:inherit;background:#fff;transform-origin:left center;
    animation:dotfill var(--auto,4600ms) linear both}
  .resting .dot.on::after{animation:none}
  @keyframes dotfill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  .arrow.play svg.pause{display:block} .arrow.play svg.go-on{display:none}
  .resting .arrow.play svg.pause{display:none} .resting .arrow.play svg.go-on{display:block}
  .hint{margin:14px 0 0;text-align:center;color:var(--faint);font-size:12px}
  .hint kbd{font:500 10.5px var(--mono);padding:2px 6px;border-radius:6px;border:1px solid var(--edge);background:var(--glass);color:var(--dim)}

  /* ── the reader: a card, popped out ── */
  .veil{position:fixed;inset:0;z-index:40;background:rgba(3,5,8,.62);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    opacity:0;pointer-events:none;transition:opacity .35s var(--ease)}
  .veil.on{opacity:1;pointer-events:auto}
  .reader{position:fixed;z-index:41;left:50%;top:50%;width:min(880px,calc(100vw - 32px));
    height:auto;min-height:min(340px,80vh);max-height:min(86vh,900px);
    margin:0;transform:translate(-50%,-50%);display:none;flex-direction:column;border-radius:var(--r);overflow:hidden;
    background:linear-gradient(160deg,rgba(255,255,255,.12),rgba(255,255,255,.04) 30%,rgba(9,13,19,.72) 70%);
    border:1px solid rgba(255,255,255,.18);
    backdrop-filter:blur(34px) saturate(150%);-webkit-backdrop-filter:blur(34px) saturate(150%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 60px 140px -50px rgba(0,0,0,.95);transform-origin:center}
  .reader.on{display:flex}
  .reader::before{content:"";position:absolute;width:420px;height:420px;right:-140px;top:-170px;border-radius:50%;
    background:radial-gradient(circle,var(--tint),transparent 68%);opacity:.22;pointer-events:none}
  .r-head{position:relative;flex:none;display:flex;align-items:center;gap:14px;padding:20px 24px 18px;border-bottom:1px solid rgba(255,255,255,.1)}
  .r-head .ico{flex:none}
  .r-head .num{display:block}
  .r-head h2{margin:2px 0 0;font:300 25px/1.15 var(--display);letter-spacing:-.02em;color:var(--ink)}
  .r-ctl{margin-left:auto;display:flex;gap:8px}
  .r-btn{width:38px;height:38px;border-radius:50%;border:1px solid var(--edge-2);background:rgba(0,0,0,.25);cursor:pointer;
    display:grid;place-items:center;transition:transform .25s var(--ease),background .25s var(--ease)}
  .r-btn:hover{transform:scale(1.08);background:var(--glass-2)}
  .r-btn:disabled{opacity:.3;cursor:default;transform:none}
  .r-body{position:relative;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:26px 30px 40px;scroll-padding-top:20px}
  .r-body > *{opacity:0;transform:translateY(8px);transition:opacity .4s var(--ease),transform .4s var(--ease)}
  .reader.shown .r-body > *{opacity:1;transform:none}

  .r-body h3{margin:30px 0 8px;font:500 17px var(--sans);color:var(--ink)}
  .r-body h4{margin:22px 0 6px;font:500 14.5px var(--sans);color:var(--ink)}
  .r-body p{margin:0 0 14px;max-width:72ch}
  .r-body ul,.r-body ol{margin:0 0 16px;padding-left:22px;max-width:72ch}
  .r-body li{margin:5px 0}
  .r-body code{font:13px var(--mono);background:rgba(0,0,0,.4);border:1px solid var(--edge);padding:1.5px 6px;border-radius:6px;color:var(--live)}
  .r-body pre{margin:0 0 18px;padding:14px 16px;border:1px solid var(--edge);border-radius:var(--r-sm);background:rgba(0,0,0,.45);overflow-x:auto}
  .r-body pre code{background:none;border:0;padding:0;color:var(--soft);font-size:12.5px;line-height:1.6}
  .r-body table{width:100%;border-collapse:collapse;margin:0 0 18px;font-size:13.5px;display:block;overflow-x:auto}
  .r-body th,.r-body td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--edge);vertical-align:top}
  .r-body th{color:var(--ink);font-weight:500;white-space:nowrap}
  .r-body blockquote{margin:0 0 16px;padding:12px 16px;border-left:2px solid rgba(90,169,255,.5);background:var(--glass);border-radius:0 var(--r-sm) var(--r-sm) 0}
  .r-body hr{border:0;border-top:1px solid var(--edge);margin:28px 0}
  .r-body b{color:var(--ink);font-weight:600}

  .store{display:none}

  .foot{position:relative;z-index:1;max-width:1180px;width:100%;margin:0 auto;padding:14px 22px 20px;display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap}

  @media (max-width:720px){
    :root{--card-w:80vw;--card-h:400px}
    .hero{align-items:flex-start}
    .reader{width:100vw;height:100dvh;border-radius:0;border:0}
    .r-body{padding:20px 18px 36px}
    .r-head{padding:16px 16px 14px}
    .r-head h2{font-size:20px}
    .hint{display:none}
  }
  @media (max-height:700px){ :root{--card-h:370px} .hero p{display:none} }
  @media (prefers-reduced-motion:reduce){
    .card{transform:none!important;opacity:1!important}
    .glass,.veil,.r-body > *,.arrow,.dot{transition:none}
    .dot.on::after{animation:none}
    .r-body > *{opacity:1;transform:none}
  }
</style>
</head>
<body>
<div class="ground"></div><div class="bloom"></div><div class="grain"></div>

<header class="top">
  <a class="brand" href="/"><i></i>Continuity <span class="tiny" style="margin-left:8px">docs</span></a>
  <a class="go" href="/chat">Open the chat &rarr;</a>
</header>

<main>
  <div class="hero">
    <div>
      <h1>How it <em>works.</em></h1>
      <p>${cards.length} sections, one card each. Pick one up to read it. Generated from the project's own README,
        so it cannot drift from the code.</p>
    </div>
    <div class="ctl" aria-label="Carousel controls">
      <button class="arrow play" id="auto" aria-label="Pause the carousel" aria-pressed="true">
        <svg class="pause" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4.5 2.5v9M9.5 2.5v9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <svg class="go-on" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 2.5l7.5 4.5L4 11.5z" fill="currentColor"/></svg>
      </button>
      <button class="arrow" id="prev" aria-label="Previous section">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="count" aria-live="polite"><b id="at">01</b> / ${String(cards.length).padStart(2, "0")}</span>
      <button class="arrow" id="next" aria-label="Next section">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>

  <div class="stage">
    <div class="track" id="track" role="list" aria-label="Documentation sections">
${cards.map((c) => `      <button class="card" role="listitem" data-id="${c.id}" style="--tint:${c.tint}" aria-label="${esc(c.title)} — open to read">
        <span class="glass">
          <span class="card-top"><span class="num">${c.n}</span><span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true">${c.icon}</svg></span></span>
          <h2>${esc(c.title)}</h2>
          <p>${esc(c.excerpt)}</p>
          <span class="card-foot"><span class="chip">${c.mins} min</span>${c.parts ? `<span class="chip">${c.parts} part${c.parts === 1 ? "" : "s"}</span>` : ""}<span class="read">Read <svg width="14" height="14" viewBox="0 0 17 17" fill="none"><path d="M3 8.5h11M9.5 4l4.5 4.5L9.5 13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span>
        </span>
      </button>`).join("\n")}
    </div>
  </div>

  <div class="dots" id="dots">${cards.map((c, i) => `<button class="dot" data-i="${i}" aria-label="Go to ${esc(c.title)}"></button>`).join("")}</div>
  <p class="hint">Turns on its own &nbsp;·&nbsp; <kbd>&larr;</kbd> <kbd>&rarr;</kbd> to move &nbsp;·&nbsp; <kbd>Enter</kbd> to open &nbsp;·&nbsp; <kbd>Esc</kbd> to close</p>
</main>

<!-- Every section's full text, out of sight until its card is opened. Kept in
     the document rather than fetched, so the page works offline and a search
     engine can still read all of it. -->
<div class="store" id="store">
${cards.map((c) => `<section data-for="${c.id}">\n${c.body}\n</section>`).join("\n")}
</div>

<div class="veil" id="veil"></div>
<article class="reader" id="reader" role="dialog" aria-modal="true" aria-labelledby="r-title">
  <header class="r-head">
    <span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true" id="r-ico"></svg></span>
    <div><span class="num" id="r-num"></span><h2 id="r-title"></h2></div>
    <div class="r-ctl">
      <button class="r-btn" id="r-prev" aria-label="Previous section"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="r-btn" id="r-next" aria-label="Next section"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="r-btn" id="r-close" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 2.5l9 9M11.5 2.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    </div>
  </header>
  <div class="r-body" id="r-body"></div>
</article>

<footer class="foot">
  <span class="tiny">Answered by an open-weight model · never Claude or GPT</span>
  <span class="tiny"><a href="https://walrus.xyz" target="_blank" rel="noopener">Walrus mainnet</a></span>
</footer>

<script>
(function () {
  var track = document.getElementById("track");
  var cards = [].slice.call(track.querySelectorAll(".card"));
  var dots = [].slice.call(document.querySelectorAll(".dot"));
  var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var current = 0;
  var open = -1;   // which section the reader is showing, or -1

  /* ── the carousel ──
     Each card leans away from the centre in proportion to how far it is from
     it, so the one in the middle faces you and the rest fall back. Measured
     on every scroll frame; nothing else moves them. */
  var ticking = false;
  function shape() {
    ticking = false;
    var mid = track.scrollLeft + track.clientWidth / 2;
    var best = 0, bestD = Infinity;
    cards.forEach(function (c, i) {
      var centre = c.offsetLeft + c.offsetWidth / 2;
      var d = (centre - mid) / c.offsetWidth;          // in card-widths
      var a = Math.min(Math.abs(d), 2.2);
      if (!still) {
        c.style.setProperty("--ry", (-Math.max(-1.6, Math.min(1.6, d)) * 15).toFixed(2) + "deg");
        c.style.setProperty("--s", (1 - a * 0.085).toFixed(3));
        c.style.setProperty("--o", (1 - Math.min(a, 2) * 0.24).toFixed(3));
      }
      if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = i; }
    });
    if (best !== current) { current = best; mark(); }
  }
  function mark() {
    if (typeof sync === "function") setTimeout(sync, 0);
    document.getElementById("at").textContent = String(current + 1).padStart(2, "0");
    dots.forEach(function (d, i) { d.classList.toggle("on", i === current); });
    document.getElementById("prev").disabled = current === 0;
    document.getElementById("next").disabled = current === cards.length - 1;
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(shape); } }
  function goTo(i, instant) {
    i = Math.max(0, Math.min(cards.length - 1, i));
    var c = cards[i];
    track.scrollTo({ left: c.offsetLeft + c.offsetWidth / 2 - track.clientWidth / 2, behavior: instant || still ? "auto" : "smooth" });
  }
  track.addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  document.getElementById("prev").addEventListener("click", function () { goTo(current - 1); });
  document.getElementById("next").addEventListener("click", function () { goTo(current + 1); });
  dots.forEach(function (d) { d.addEventListener("click", function () { goTo(Number(d.dataset.i)); }); });

  /* ── it turns on its own ──
     Every few seconds the next card comes round, and after the last one the
     first. It rests while you are doing something with it — pointing at it,
     tabbing through it, dragging it, reading a section — and picks up again
     when you stop. Anyone who has asked their system for less motion gets a
     carousel that stays where they put it. */
  var AUTO = 4600, clock = null, wanted = !still, holds = 0;
  var root = document.documentElement;
  root.style.setProperty("--auto", AUTO + "ms");
  function resting() { return !wanted || holds > 0 || open >= 0 || document.hidden; }
  function sync() {
    root.classList.toggle("resting", resting());
    clearTimeout(clock); clock = null;
    if (resting()) return;
    // restart the dot's fill so the clock on screen matches the one here
    var on = document.querySelector(".dot.on");
    if (on) { on.classList.remove("on"); void on.offsetWidth; on.classList.add("on"); }
    clock = setTimeout(function () { goTo(current === cards.length - 1 ? 0 : current + 1); }, AUTO);
  }
  function hold() { holds++; sync(); }
  function release() { holds = Math.max(0, holds - 1); sync(); }
  var stageEl = document.querySelector(".stage");
  stageEl.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse") hold(); });
  stageEl.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") release(); });
  stageEl.addEventListener("focusin", hold);
  stageEl.addEventListener("focusout", release);
  document.addEventListener("visibilitychange", sync);
  document.getElementById("auto").addEventListener("click", function () {
    wanted = !wanted;
    this.setAttribute("aria-pressed", String(wanted));
    this.setAttribute("aria-label", wanted ? "Pause the carousel" : "Play the carousel");
    sync();
  });

  // A mouse wheel moves the carousel sideways; a trackpad already does.
  track.addEventListener("wheel", function (e) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { track.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });

  // Drag to move. A drag that travelled is not a click on whatever it ended on.
  var drag = null, moved = false;
  track.addEventListener("pointerdown", function (e) {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    drag = { x: e.clientX, left: track.scrollLeft }; moved = false;
  });
  addEventListener("pointermove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x;
    if (!moved && Math.abs(dx) > 6) { moved = true; track.classList.add("dragging"); }
    if (moved) track.scrollLeft = drag.left - dx;
  });
  addEventListener("pointerup", function () {
    if (!drag) return;
    drag = null;
    if (moved) { track.classList.remove("dragging"); goTo(current); setTimeout(function () { moved = false; }, 0); }
  });

  /* ── the reader ──
     The card's own rectangle is where the reader starts, so it reads as that
     card coming forward rather than a box appearing over the page. The section
     is MOVED in from the store and moved back, never copied: its heading ids
     stay unique, so a link to a sub-heading keeps working. */
  var reader = document.getElementById("reader"), veil = document.getElementById("veil"), body = document.getElementById("r-body");
  var store = document.getElementById("store");
  var lastFocus = null;

  function sectionOf(id) { return store.querySelector('section[data-for="' + id + '"]'); }
  function putBack() {
    if (open < 0) return;
    var home = sectionOf(cards[open].dataset.id);
    while (body.firstChild) home.appendChild(body.firstChild);
  }
  function fill(i) {
    var c = cards[i];
    putBack();
    var src = sectionOf(c.dataset.id);
    while (src.firstChild) body.appendChild(src.firstChild);
    document.getElementById("r-num").textContent = c.querySelector(".num").textContent;
    document.getElementById("r-title").textContent = c.querySelector("h2").textContent;
    document.getElementById("r-ico").innerHTML = c.querySelector(".ico svg").innerHTML;
    reader.style.setProperty("--tint", c.style.getPropertyValue("--tint"));
    document.getElementById("r-prev").disabled = i === 0;
    document.getElementById("r-next").disabled = i === cards.length - 1;
    body.scrollTop = 0;
    open = i;
  }
  function fromRect(el) {
    var r = el.getBoundingClientRect(), f = reader.getBoundingClientRect();
    return "translate(-50%,-50%) translate(" + (r.left + r.width / 2 - (f.left + f.width / 2)) + "px," +
      (r.top + r.height / 2 - (f.top + f.height / 2)) + "px) scale(" + (r.width / f.width) + "," + (r.height / f.height) + ")";
  }
  function show(i, opts) {
    opts = opts || {};
    var already = open >= 0;
    lastFocus = lastFocus || document.activeElement;
    fill(i);
    reader.classList.add("on"); veil.classList.add("on"); sync();
    document.documentElement.style.overflow = "hidden";
    if (!opts.quiet) history.replaceState(null, "", "#" + cards[i].dataset.id);
    if (already || still) {                       // stepping between sections: just restage the text
      reader.classList.remove("shown"); void reader.offsetWidth; reader.classList.add("shown");
    } else {
      reader.classList.remove("shown");
      reader.style.transition = "none";
      reader.style.transform = "translate(-50%,-50%)";
      var start = fromRect(cards[i]);
      reader.style.transform = start; reader.style.opacity = "0.4";
      void reader.offsetWidth;
      reader.style.transition = "transform .5s cubic-bezier(.22,1,.36,1), opacity .3s ease";
      reader.style.transform = "translate(-50%,-50%)"; reader.style.opacity = "1";
      setTimeout(function () { reader.classList.add("shown"); }, 160);
    }
    goTo(i, true);
    if (opts.anchor) setTimeout(function () { var t = document.getElementById(opts.anchor); if (t) t.scrollIntoView({ block: "start" }); }, 380);
    document.getElementById("r-close").focus({ preventScroll: true });
  }
  function hide() {
    if (open < 0) return;
    var i = open;
    reader.classList.remove("shown");
    veil.classList.remove("on");
    document.documentElement.style.overflow = "";
    history.replaceState(null, "", location.pathname);
    var done = function () {
      reader.classList.remove("on");
      reader.style.transition = ""; reader.style.transform = ""; reader.style.opacity = "";
      putBack(); open = -1; sync();
      if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
      lastFocus = null;
    };
    if (still) return done();
    reader.style.transition = "transform .38s cubic-bezier(.4,0,.2,1), opacity .3s ease .08s";
    reader.style.transform = "translate(-50%,-50%)"; void reader.offsetWidth;
    reader.style.transform = fromRect(cards[i]); reader.style.opacity = "0";
    setTimeout(done, 390);
  }

  cards.forEach(function (c, i) {
    c.addEventListener("click", function () {
      if (moved) return;
      if (i !== current) { goTo(i); setTimeout(function () { show(i); }, still ? 0 : 320); return; }
      show(i);
    });
  });
  document.getElementById("r-close").addEventListener("click", hide);
  veil.addEventListener("click", hide);
  document.getElementById("r-prev").addEventListener("click", function () { if (open > 0) show(open - 1); });
  document.getElementById("r-next").addEventListener("click", function () { if (open < cards.length - 1) show(open + 1); });

  addEventListener("keydown", function (e) {
    if (open >= 0) {
      if (e.key === "Escape") hide();
      else if (e.key === "ArrowLeft" && open > 0) show(open - 1);
      else if (e.key === "ArrowRight" && open < cards.length - 1) show(open + 1);
      return;
    }
    if (e.key === "ArrowLeft") { goTo(current - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { goTo(current + 1); e.preventDefault(); }
    else if (e.key === "Enter" && document.activeElement === document.body) show(current);
  });

  // Links to a heading, from inside a section or from another page: find the
  // section that holds it and open that one at the heading.
  function openHash(hash, quiet) {
    var id = decodeURIComponent(String(hash || "").replace("#", ""));
    if (!id) return false;
    var i = cards.findIndex(function (c) { return c.dataset.id === id; });
    if (i >= 0) { show(i, { quiet: quiet }); return true; }
    var el = document.getElementById(id);
    var sec = el && el.closest("section[data-for]");
    if (!sec && el && body.contains(el)) { el.scrollIntoView({ block: "start" }); return true; }
    if (!sec) return false;
    i = cards.findIndex(function (c) { return c.dataset.id === sec.dataset.for; });
    if (i < 0) return false;
    show(i, { quiet: quiet, anchor: id });
    return true;
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a && openHash(a.getAttribute("href"))) e.preventDefault();
  });
  addEventListener("hashchange", function () { openHash(location.hash, true); });

  goTo(0, true); shape(); mark(); sync();
  if (location.hash) openHash(location.hash, true);
})();
</script>
</body>
</html>
`;

writeFileSync(join(root, "src/web/docs.html"), page);
console.log(`wrote src/web/docs.html — ${(page.length / 1024).toFixed(1)}KB, ${cards.length} sections`);

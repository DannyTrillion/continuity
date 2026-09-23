#!/usr/bin/env node
/**
 * Fill the shared knowledge base from the real Walrus docs.
 *
 *   node tools/seed-kb.mjs            # the curated list
 *   node tools/seed-kb.mjs <url>...   # specific pages
 *   PAGE_CHUNKS=2 node tools/seed-kb.mjs
 *
 * Without this the bot invents Walrus specifics — it confidently recommended
 * `walrus publisher --list`, which is not a command. Grounding it in the docs
 * is the difference between a support bot and a plausible liar.
 *
 * The relayer's own extractor is deliberately NOT used here. It is tuned for
 * conversation, so documentation comes back phrased about a person — "User
 * generates a delegate key pair" — which is worse than useless in a shared
 * knowledge base, where it can be mistaken for a fact about whoever is asking.
 * Instead the model rewrites each chunk into impersonal, self-contained
 * statements and those are stored verbatim.
 *
 * Every statement is a blob on mainnet, so this costs WAL: a deliberate,
 * occasional job, not something that runs on boot.
 */

import { readPage } from "../src/core/web.mjs";
import { rememberMany, KB_NS, recall } from "../src/core/memory.mjs";
import { chat } from "../src/core/llm.mjs";

const CURATED = [
  "https://docs.wal.app/walrus-memory/troubleshooting/overview",
  "https://docs.wal.app/docs/http-api/storing-blobs",
  "https://docs.wal.app/docs/getting-started",
  "https://docs.wal.app/docs/sites",
  "https://docs.wal.app/docs/system-overview/storage-costs",
  "https://docs.wal.app/docs/glossary",
  "https://docs.wal.app/walrus-memory/getting-started/quick-start",
  "https://docs.wal.app/docs/operator-guide/limitations",
];

const CHUNK_CHARS = 1800;
const CHUNKS_PER_PAGE = Number(process.env.PAGE_CHUNKS ?? 3);

/** Split on blank lines so a fact is never cut in half mid-sentence. */
function chunk(text) {
  const out = [];
  let buf = "";
  for (const para of text.split(/\n{2,}/)) {
    if ((buf + "\n\n" + para).length > CHUNK_CHARS) {
      if (buf.trim()) out.push(buf.trim());
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((c) => c.length > 220); // skip nav scraps
}

/**
 * Turn a slab of documentation into standalone statements.
 *
 * Each one has to survive being recalled on its own months from now, with no
 * surrounding page and no metadata — so it names Walrus explicitly and carries
 * its own source.
 */
async function extract(part, page) {
  const { text } = await chat([
    {
      role: "system",
      content:
        "You turn documentation into standalone factual statements for a support knowledge base.\n\n" +
        "Rules:\n" +
        "- One fact per line. No numbering, no bullets, no preamble.\n" +
        "- Impersonal. Never write \"User\", \"You\" or \"Assistant\" — write about Walrus, the CLI, the publisher, the relayer.\n" +
        "- Self-contained. Each line must make sense alone, so name the thing: \"Walrus storage epochs...\" not \"They last...\".\n" +
        "- Concrete only: commands, flags, limits, error causes, defaults, URLs. Skip marketing and navigation.\n" +
        "- Never invent a command, flag or number that is not in the text.\n" +
        "- At most 10 lines. Fewer is fine if the text is thin.",
    },
    { role: "user", content: `Source: ${page.title} — ${page.url}\n\n${part}` },
  ], { temperature: 0.1, maxTokens: 900 });

  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 30 && !/^(user|you|assistant)\b/i.test(l))
    .slice(0, 10)
    .map((l) => `${l} [Walrus docs: ${page.url}]`);
}

const urls = process.argv.slice(2).length ? process.argv.slice(2) : CURATED;
let facts = 0;
let blobs = 0;

for (const url of urls) {
  const page = await readPage(url);
  if (!page.ok) {
    console.log(`SKIP  ${url} — ${page.error}`);
    continue;
  }
  const parts = chunk(page.text).slice(0, CHUNKS_PER_PAGE);
  console.log(`\n${page.title}\n  ${url}\n  ${page.text.length} chars → ${parts.length} chunk(s)`);

  for (const [i, part] of parts.entries()) {
    try {
      const statements = await extract(part, page);
      facts += statements.length;
      for (const text of statements) console.log(`     • ${text.slice(0, 100)}`);

      // One batched call rather than one round trip per statement.
      const written = await rememberMany(KB_NS, statements);
      const ok = written.filter((w) => w.blobId).length;
      blobs += ok;
      console.log(`  chunk ${i + 1}: ${statements.length} statement(s), ${ok} stored`);
    } catch (err) {
      console.log(`  chunk ${i + 1}: FAILED — ${err.message.slice(0, 90)}`);
    }
  }
}

console.log(`\n${facts} statements extracted, ${blobs} blobs written to ${KB_NS}`);
const check = await recall(KB_NS, "publisher returns 403 when storing a blob", { limit: 3 });
console.log(`spot check — "publisher 403" recalls ${check.length}:`);
for (const h of check) console.log(`  • ${h.text.slice(0, 110)}`);
process.exit(0);

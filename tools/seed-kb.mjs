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

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
        "- Qualify anything that differs by network. Walrus epoch length, publisher\n" +
        "  availability and costs are not the same on Mainnet and Testnet, and a fact\n" +
        "  stored without saying which one is worse than no fact: it will be recalled\n" +
        "  months later with no context and contradict its neighbour.\n" +
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

/**
 * What has already been written, so a re-run fills gaps instead of duplicating.
 *
 * Bulk writes fail individually and silently — 77 of 190 statements did not
 * land on the first pass — and storage is append-only, so re-running blindly
 * would double everything that did work. Keyed by a hash of the statement.
 */
const LEDGER = new URL("../kb-seeded.json", import.meta.url).pathname;
const seeded = new Set(existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : []);
const keyOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const saveLedger = () => writeFileSync(LEDGER, JSON.stringify([...seeded]));

const urls = process.argv.slice(2).length ? process.argv.slice(2) : CURATED;
let facts = 0;
let blobs = 0;
let skipped = 0;

for (const url of urls) {
  const page = await readPage(url);
  if (!page.ok) {
    console.log(`SKIP  ${url} — ${page.error}`);
    continue;
  }
  const parts = chunk(page.text).slice(0, CHUNKS_PER_PAGE);
  console.log(`\n${page.title}\n  ${url}\n  ${page.text.length} chars → ${parts.length} chunk(s)`);

  for (const [i, part] of parts.entries()) {
    // Identity of a chunk is its own text, so edits to the docs re-seed and
    // an unchanged page costs nothing at all.
    const chunkKey = `chunk:${keyOf(url + "#" + part)}`;
    if (seeded.has(chunkKey)) {
      console.log(`  chunk ${i + 1}: already seeded`);
      skipped++;
      continue;
    }

    try {
      const statements = await extract(part, page);

      // The ledger starts empty on a machine that has already seeded, so ask
      // the namespace itself before writing. Chunks land more or less together,
      // so probing one statement tells us whether this chunk is already in.
      if (statements.length && !seeded.has(keyOf(statements[0]))) {
        const probe = await recall(KB_NS, statements[0], { limit: 3 });
        if (probe.some((h) => h.text.trim() === statements[0].trim())) {
          for (const t of statements) seeded.add(keyOf(t));
          saveLedger();
        }
      }

      const fresh = statements.filter((t) => !seeded.has(keyOf(t)));
      skipped += statements.length - fresh.length;
      facts += fresh.length;
      if (!fresh.length) {
        console.log(`  chunk ${i + 1}: nothing new`);
        continue;
      }
      for (const text of fresh) console.log(`     • ${text.slice(0, 100)}`);

      // One batched call rather than one round trip per statement.
      const written = await rememberMany(KB_NS, fresh);
      const ok = written.filter((w) => w.blobId);
      for (const w of ok) seeded.add(keyOf(w.text));
      saveLedger();
      blobs += ok.length;

      if (ok.length === written.length) {
        seeded.add(chunkKey); // only mark the chunk done when all of it landed
        saveLedger();
      }

      const lost = written.length - ok.length;
      console.log(
        `  chunk ${i + 1}: ${fresh.length} statement(s), ${ok.length} stored` +
          (lost ? ` — ${lost} did not land, will retry on the next run` : ""),
      );
    } catch (err) {
      console.log(`  chunk ${i + 1}: FAILED — ${err.message.slice(0, 90)}`);
    }
  }
}

console.log(`\n${facts} new statement(s), ${blobs} stored, ${skipped} chunk(s)/statement(s) skipped — ${KB_NS}`);
const check = await recall(KB_NS, "publisher returns 403 when storing a blob", { limit: 3 });
console.log(`spot check — "publisher 403" recalls ${check.length}:`);
for (const h of check) console.log(`  • ${h.text.slice(0, 110)}`);
process.exit(0);

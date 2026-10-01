#!/usr/bin/env node
/**
 * Files it says it accepts, and what it keeps of them.
 *
 *   node --env-file=.env tools/check-files.mjs
 *
 * The chat used to accept .pdf, .txt and .md and store "a PDF file named
 * report.pdf (240KB)" for all three — a sentence matching nothing anyone
 * would search for, so the file was gone the moment it arrived. These checks
 * are mostly about that: what is offered is what can be read, and what is
 * read is worth finding again.
 *
 * Only the long-document case needs the model. Nothing here touches Walrus.
 */
import { readFileSync } from "node:fs";
import { readDocument, canRead } from "../src/core/documents.mjs";

let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  const said = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${said ? ` — ${said.replace(/\s+/g, " ").slice(0, 96)}` : ""}`);
};
const section = (t) => console.log(`\n── ${t}`);
const buf = (s) => Buffer.from(s, "utf8");

section("what it offers is what it can read");
const accept = readFileSync("src/web/chat.html", "utf8").match(/id="file"[^>]*accept="([^"]+)"/)?.[1] ?? "";
check("the chat still takes text files", /\.txt/.test(accept) && /\.md/.test(accept), accept);
check("and no longer promises PDFs it cannot read", !/\.pdf/.test(accept), accept);
for (const [type, ext, want] of [
  ["text/plain", "txt", true], ["text/markdown", "md", true], ["text/csv", "csv", true],
  ["application/json", "json", true], ["", "yaml", true],
  ["image/png", "png", false], ["application/pdf", "pdf", false], ["application/octet-stream", "bin", false],
]) check(`${ext} is ${want ? "readable" : "not"}`, canRead(type, ext) === want);
check("everything the chat offers, it can read",
  accept.split(",").filter((a) => a.startsWith(".")).every((a) => canRead("", a.slice(1))), accept);

section("a short file is its own memory");
const note = "Remember: I'm allergic to shellfish and I don't drink.";
const short = await readDocument({ bytes: buf(note), name: "note.txt", type: "text/plain" });
check("it is kept", short.ok);
check("word for word, because nothing describes it better", short.description.includes(note));
check("and says what it was called", short.description.includes('"note.txt"'), short.description.slice(0, 60));
check("no model was needed for it", short.verbatim === true);

section("what it refuses, and says so");
const empty = await readDocument({ bytes: buf("   \n\n  "), name: "empty.txt", type: "text/plain" });
check("an empty file is not a memory", !empty.ok, empty.error);
const binary = await readDocument({ bytes: readFileSync("src/web/assets/avatar.png").subarray(0, 3000), name: "sneaky.txt", type: "text/plain" });
check("a picture wearing a .txt is caught", !binary.ok, binary.error);
check("and the reason is one a person can read", /text/i.test(binary.error ?? ""), binary.error);

section("a long one is described so it can be found again");
if (!process.env.OPENROUTER_API_KEY) {
  console.log("SKIP  no model key — the long-document path needs one");
} else {
  const doc = `Deployment runbook

Host: Railway, service continuity-production-6084
Volume mounted at /data (outbox, ledger and uploads live there)
Deploy with: railway up --detach
Env that must be set: OPENROUTER_API_KEY, WALRUS_RELAYER_URL, PUBLIC_URL
If writes stall, check the relayer rate limit before anything else.
`.repeat(3);
  const long = await readDocument({ bytes: buf(doc), name: "runbook.md", type: "text/markdown" });
  check("it is read", long.ok, long.error);
  check("and not just quoted back", long.verbatim !== true);
  check("it keeps the exact words someone would search for",
    /\/data/.test(long.description) && /railway/i.test(long.description), long.description.slice(0, 90));
  check("it says how big it was", /\d+ lines/.test(long.description));
  check("and quotes the opening, so the memory is worth having", /It begins: "/.test(long.description));
  check("the whole thing stays a sensible size for a memory", long.description.length < 2000, long.description.length + " chars");
}

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);

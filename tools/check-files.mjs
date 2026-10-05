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
import { fileNs, fileSentence, parseFile, asksForFile, loadFile } from "../src/core/files.mjs";
import { loadImage } from "../src/core/images.mjs";
import { putBlob, getBlob, config as walrusConfig } from "../src/core/walrus.mjs";

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
/* PDFs were refused for a long time because extracting text from one needs a
   real parser. It has one now (unpdf), and lecture notes and handouts are
   overwhelmingly PDFs — so the promise is kept rather than withdrawn. A PDF
   of scanned pages still cannot be read, and says so. */
check("and offers PDFs, now that it can read them", /\.pdf/.test(accept), accept);
for (const [type, ext, want] of [
  ["text/plain", "txt", true], ["text/markdown", "md", true], ["text/csv", "csv", true],
  ["application/json", "json", true], ["", "yaml", true],
  ["image/png", "png", false], ["application/pdf", "pdf", true], ["application/octet-stream", "bin", false],
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

section("a file is kept as a file, not as a photograph of one");

/* Every attachment that was not a study material used to be written by
   `rememberImage`, so a PDF of someone's lease was stored as "a picture the
   user shared" and filed under Photos. These checks are about the two halves
   of the fix: the agent routes by kind, and what the file shelf writes is what
   the file shelf can read back.

   The round trip matters more than it looks. Both ends are regexes over a
   sentence, written in two different files, and nothing but a test makes them
   agree — a prefix changed at one end silently empties the shelf at the other,
   while the memories sit on Walrus perfectly intact. */
const agent = readFileSync("src/core/agent.mjs", "utf8");
check("a document no longer goes to the picture bank",
  /attachment\.kind !== "image"[\s\S]{0,400}rememberFile\(/.test(agent));
check("a photo still does",
  /else \{\s*rememberImage\(/.test(agent));
check("and a tutor's material still goes to the things being studied",
  /mode === "tutor" && attachment\.kind === "document"[\s\S]{0,200}rememberMaterial\(/.test(agent));

check("files get a namespace of their own", fileNs("p1") === "ws8::file::p1", fileNs("p1"));

/* The round trip, with no relayer in the way: build the sentence that gets
   stored, then read it back the way the shelf does. The two regexes live at
   opposite ends of files.mjs and only this keeps them agreeing. */
{
  const written = fileSentence({
    file: "abc-123.pdf",
    name: "lease.pdf",
    description: "A residential tenancy agreement for 14 Oak Road, twelve months from 1 November, rent 1450 a month.",
    pages: 9,
    surface: "telegram",
    said: "keep this somewhere safe",
    at: Date.parse("2026-10-04T10:00:00Z"),
  });
  const f = parseFile({ text: written, created_at: "2026-10-04T10:00:00Z", blob_id: "BLOB1" });

  check("the file reference survives the round trip", f.file === "abc-123.pdf", f.file);
  check("so does which app it came from", f.surface === "telegram", f.surface);
  check("the name is pulled back out of the sentence", f.name === "lease.pdf", f.name);
  check("the summary is what the file said, not what it was called",
    /tenancy agreement/.test(f.description) && !/lease\.pdf/.test(f.description), f.description.slice(0, 64));
  check("the page count comes back as a number", f.pages === 9, f.pages);
  check("what they said while sending it is kept apart from the summary",
    f.said === "keep this somewhere safe", f.said);
  check("the blob id rides along, so the shelf can prove it", f.blobId === "BLOB1", f.blobId);
  check("a file whose bytes are gone is marked unavailable, not linked",
    f.available === false, f.available);

  // A file with no page count and nothing said is the common case, and the
  // optional halves of the sentence must not leak into the summary.
  const bare = parseFile({ text: fileSentence({
    file: "n.txt", name: "notes.txt", description: "Shopping list: oats, tahini, lemons.", surface: "web",
  }) });
  check("the plain case keeps its summary clean",
    bare.description === "Shopping list: oats, tahini, lemons." && bare.pages === null && bare.said === null,
    JSON.stringify({ d: bare.description, p: bare.pages, s: bare.said }));
}

/* The dashboard has to actually offer the shelf, or the memories are written
   and never shown — which is the state this started in. */
const dash = readFileSync("src/web/memory.html", "utf8");
check("the dashboard has a Files shelf", /id: "files", label: "Files"/.test(dash));
check("and draws a file row rather than a fact row", /function fileHtml\(/.test(dash));
check("fed by what the API returns", /b\.set\("files", data\.files/.test(dash));
const srv = readFileSync("src/server.mjs", "utf8");
check("which the API actually sends", /\n\s*files,\n/.test(srv));
check("and which unions tutor materials in, so nothing hides",
  /listMaterials\(who\.personId\)/.test(srv));

/* Pasting a file was the gesture that did nothing at all. */
const chat = readFileSync("src/web/chat.html", "utf8");
check("pasting a file attaches it", /addEventListener\("paste"/.test(chat) && /clipboardData/.test(chat));
check("dropping one does too", /addEventListener\("drop"/.test(chat));
check("and an ordinary text paste is left alone",
  /if \(!items\.length\) return;/.test(chat));

section("the bytes outlive the server");

/* The half that was missing. A description of a file was always durable,
   because it is a memory and memories are on Walrus; the bytes sat on a
   Railway volume that a redeploy empties, so the memory outlived the file it
   described. These checks are the round trip that fixes that — a real upload
   and a real download, because a mocked one would prove nothing about whether
   the publisher we point at actually works. */
{
  check("the blob id rides inside the memory, beside the filename",
    /\[walrus:/.test(fileSentence({ file: "a.pdf", description: "x", surface: "web", walrusBlob: "BLOBID123" })));
  const back = parseFile({ text: fileSentence({
    file: "a.pdf", name: "a.pdf", description: "A one page invoice.", surface: "web", walrusBlob: "BLOBID123" }) });
  check("and comes back out of it", back.walrusBlob === "BLOBID123", back.walrusBlob);
  check("the summary is not polluted by either reference",
    back.description === "A one page invoice.", back.description);
  /* The point of all of it: a file whose bytes are gone from this disk is
     still openable, because the memory knows where else to look. */
  check("a file off the volume but on Walrus is available, not lost",
    back.available === true && back.onDisk === false && back.url === "/blob/BLOBID123", back.url);
  const orphan = parseFile({ text: fileSentence({ file: "b.pdf", description: "y", surface: "web" }) });
  check("and one that never reached Walrus is honestly unavailable",
    orphan.available === false && orphan.url === null, orphan.url);
}

if (process.env.SKIP_NETWORK) {
  console.log("SKIP  no network checks — SKIP_NETWORK is set");
} else {
  const cfg = walrusConfig();
  console.log(`      publisher: ${cfg.publisher} (${cfg.network})`);
  const bytes = Buffer.from("continuity round trip " + Date.now(), "utf8");
  const put = await putBlob(bytes);
  check("bytes go to Walrus and come back with an id", !!put?.blobId, put?.blobId);
  if (put?.blobId) {
    const got = await getBlob(put.blobId);
    check("and read back byte for byte", got?.equals(bytes) === true,
      got ? `${got.length} bytes` : "nothing came back");
  }
  check("an empty upload is refused rather than stored", (await putBlob(Buffer.alloc(0))) === null);
  check("a nonsense blob id returns null instead of throwing",
    (await getBlob("not-a-real-blob-id-at-all-xxxxxxxxxxxxxxxxx")) === null);
}

section("asking for a file back");

/* Danny, on Telegram, after sending a PDF: "could you fetch me the pdf i sent
   to you". The bot replied "I can't fetch or display the PDF itself — I only
   have the description", which was false twice over: the bytes were on this
   disk AND on Walrus. Pictures had a fetch path and files simply did not. */
{
  const yes = [
    "could you fetch me the pdf i sent to you",
    "send me that file again",
    "where are my lecture notes",
    "can I have the lease document",
    "do you still have that spreadsheet",
  ];
  const no = ["show me the picture", "what do you know about me", "send it over", "how are you"];
  check("it hears somebody asking for a file", yes.every(asksForFile), yes.filter((q) => !asksForFile(q)));
  /* Narrow on purpose: it runs on every turn, and handing somebody a lease
     because they said "send it" about a link is worse than not fetching. */
  check("and does not hear it in everything else", !no.some(asksForFile), no.filter(asksForFile));
}

section("the bytes come back from wherever they still are");
{
  const offDisk = parseFile({ text: fileSentence({
    file: "definitely-not-on-this-disk.md", name: "proof.md", surface: "web",
    description: "A deploy check.",
    walrusBlob: "Eab86j7CBtdMwiw2S7awVAnUfGWLO6JyHPffmgnzBbw",
  }) });
  check("a file off this disk still counts as available",
    offDisk.available === true && offDisk.onDisk === false, offDisk.url);

  check("a path trying to climb out of the uploads directory is refused",
    (await loadFile({ file: "../../etc/passwd", walrusBlob: null })) === null);
  check("and one that reached neither disk nor Walrus returns null, not a throw",
    (await loadFile(parseFile({ text: fileSentence({ file: "nope.md", description: "x", surface: "web" }) }))) === null);

  if (process.env.SKIP_NETWORK) {
    console.log("SKIP  the Walrus fetch — SKIP_NETWORK is set");
  } else {
    /* The whole point of putting attachment bytes on Walrus: the server losing
       them stops mattering. This fetches a blob written from production. */
    const got = await loadFile(offDisk);
    check("gone from the volume, it is fetched back from Walrus",
      got?.from === "walrus", got ? `${got.bytes.length} bytes` : "nothing came back");
    check("byte for byte, with the name it was sent under",
      /outlived the server/.test(got?.bytes?.toString("utf8") ?? "") && got?.name === "proof.md", got?.name);
  }
}

/* The surfaces have to actually send it, and each one differently: Telegram
   compresses a photo and would destroy a PDF, so it needs sendDocument. */
{
  const tg = readFileSync("src/adapters/telegram.mjs", "utf8");
  const dc = readFileSync("src/adapters/discord.mjs", "utf8");
  const agent = readFileSync("src/core/agent.mjs", "utf8");
  check("Telegram sends it as a document, not as a photo",
    /sendDocument/.test(tg) && /form\.append\("document"/.test(tg));
  check("Discord sends a real attachment", /files: \[\{ attachment: document\.bytes/.test(dc));
  check("and the turn carries one back at all", /document: document \? \{ bytes/.test(agent));
  /* The model has to be told, or it apologises for not having the thing that
     is attached to its own reply. */
  check("the model is told the file is attached and must not deny it",
    /NEVER say you cannot fetch, \n?\s*send or display a file/.test(agent) || /never say you cannot fetch/i.test(agent));
}

section("a picture is as recoverable as a file");

/* Danny, on Discord, asking for a photo back: the reply read "Here's the
   Bugatti… [Attached: telegram-photo.jpg]" and no photo arrived. Two things
   had gone wrong and they had the same cause — the dashboard's reader was
   taught about Walrus today and the FETCH path was not, so the two drifted.
   A picture recoverable from Walrus was reported as lost by the one piece of
   code whose job is fetching it back, and the walrus reference leaked into
   the description handed to the model. */
{
  const img = readFileSync("src/core/images.mjs", "utf8");
  check("findImages strips the Walrus reference as well as the file one",
    /\.replace\(REF, ""\)\.replace\(WREF, ""\)/.test(img));
  check("and 'available' means somebody can be shown it, not that this disk has it",
    /available: onDisk \|\| !!blob/.test(img));

  check("a path climbing out of the uploads directory is refused",
    (await loadImage({ file: "../../etc/passwd" })) === null);
  check("a picture that reached neither disk nor Walrus returns null",
    (await loadImage({ file: "nope.png" })) === null);

  const agent = readFileSync("src/core/agent.mjs", "utf8");
  check("the whole match is loaded, so the blob id travels with it",
    /loadImage\(picture\)/.test(agent));
  check("a picture found but unloadable is admitted, not described as visible",
    /BYTES COULD NOT BE/.test(agent));
  /* The marker is the part Danny actually saw. Nothing in this codebase
     writes it; the model invented it, which is worse — it looks like a bug
     and is a lie. */
  check("and the model is forbidden from inventing an attachment marker",
    /Never write a marker like "\[Attached:/.test(agent));

  if (process.env.SKIP_NETWORK) {
    console.log("SKIP  the Walrus picture fetch — SKIP_NETWORK is set");
  } else {
    const got = await loadImage({ file: "not-on-this-disk-at-all.png",
      walrusBlob: "Eab86j7CBtdMwiw2S7awVAnUfGWLO6JyHPffmgnzBbw" });
    check("gone from the volume, a picture is fetched back from Walrus",
      got?.from === "walrus", got ? `${got.png.length} bytes` : "nothing came back");
  }
}

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * Does this actually speak MCP, or does it only look like it does?
 *
 * The protocol is hand-rolled, which buys no dependency and costs the
 * guarantee that somebody else got the handshake right. So this drives it the
 * way a client does: initialize, the notification that follows, tools/list,
 * then real calls. Both transports, because there are two and they must not
 * drift.
 *
 *   node --env-file=.env tools/check-mcp.mjs
 *
 * The thing most likely to be wrong is notifications. A message with no `id`
 * must produce no reply; a server that answers one makes a conforming client
 * hang waiting for a response to something it never asked about. That is
 * exactly the failure you cannot see by hand-testing with curl, so it is
 * checked first and twice.
 */

import { spawn } from "node:child_process";
import { dispatch, TOOLS, PROTOCOL } from "../src/mcp.mjs";

let failures = 0;
let ran = 0;
const check = (what, ok, detail) => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};
const section = (s) => console.log(`\n── ${s}`);

const call = (method, params, id = 1) => dispatch({ jsonrpc: "2.0", id, method, params });

section("the handshake");

const init = await call("initialize", {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: "check-mcp", version: "0" },
});
check("initialize answers", Boolean(init?.result));
check("and declares a protocol version", init?.result?.protocolVersion === PROTOCOL,
  init?.result?.protocolVersion);
check("and names itself", init?.result?.serverInfo?.name === "continuity");
check("and advertises tools", Boolean(init?.result?.capabilities?.tools));
/* The instructions field is how a calling model learns the one rule this
   project exists to defend: empty is not broken. */
check("and tells the caller an empty recall is not a failure",
  /never that their memory is broken/i.test(init?.result?.instructions ?? ""));

section("notifications get no answer");

for (const method of ["notifications/initialized", "initialized"]) {
  check(`${method} returns nothing at all`,
    (await dispatch({ jsonrpc: "2.0", method })) === null);
}
/* An id of null is still a notification by the spec's reading, and a client
   that sends one is not asking to be answered. */
check("a message with a null id is treated as a notification",
  (await dispatch({ jsonrpc: "2.0", id: null, method: "ping" })) === null);
check("but a ping with a real id is answered", Boolean((await call("ping", {}))?.result));

section("the tools");

const list = await call("tools/list", {});
const tools = list?.result?.tools ?? [];
check("tools/list returns them", tools.length === TOOLS.length, `${tools.length}`);
check("every tool has a description", tools.every((t) => t.description?.length > 20));
check("every tool has an object schema",
  tools.every((t) => t.inputSchema?.type === "object" && t.inputSchema.properties));
check("every tool requires a user",
  tools.every((t) => t.inputSchema.required?.includes("user")),
  tools.filter((t) => !t.inputSchema.required?.includes("user")).map((t) => t.name).join(", "));
/* `run` is a server-side function and must never be serialised to a client. */
check("and no `run` function leaks onto the wire",
  tools.every((t) => t.run === undefined));

section("calling them");

const unknown = await call("tools/call", { name: "nope", arguments: {} });
check("an unknown tool is a protocol error", unknown?.error?.code === -32602);

const noUser = await call("tools/call", { name: "recall", arguments: { query: "anything" } });
check("a missing user is reported inside the result, not as a transport error",
  noUser?.result?.isError === true && /needs a `user`/.test(noUser.result.content[0].text));

const badMethod = await call("totally/made-up", {});
check("an unknown method is -32601", badMethod?.error?.code === -32601);

/* A real round trip. Needs the relayer, so it is the slow part of this file
   and the part that actually proves the wrapper works. */
section("a real person, end to end");

const user = `check-mcp-${Date.now().toString(36)}`;
const fact = `They are testing the MCP server on ${new Date().toISOString().slice(0, 10)}.`;

const wrote = await call("tools/call", { name: "remember", arguments: { user, fact } });
const wroteText = wrote?.result?.content?.[0]?.text ?? "";
check("remember writes and reports what happened", /walrus:|Queued/.test(wroteText), wroteText.slice(0, 80));
/* The receipt rule, which is the whole discipline: a write that landed hands
   back a blob id rather than the word "ok". */
check("a landed write returns a blob id, not a reassurance",
  !/^Written/.test(wroteText) || /walrus: \S{20,}/.test(wroteText), wroteText.slice(0, 80));

const got = await call("tools/call", { name: "recall", arguments: { user, query: "what are they doing" } });
const gotText = got?.result?.content?.[0]?.text ?? "";
check("recall answers without throwing", Boolean(gotText));
/* Empty is allowed here — the write may not have landed yet, which is the
   gap this whole project is about. What is NOT allowed is calling it broken. */
check("and an empty recall says so without blaming storage",
  !/empty or broken|service.*fail|cannot read/i.test(gotText), gotText.slice(0, 100));

const files = await call("tools/call", { name: "list_files", arguments: { user } });
check("list_files answers for somebody with none",
  /No files stored/.test(files?.result?.content?.[0]?.text ?? ""));

const photos = await call("tools/call", { name: "list_photos", arguments: { user } });
check("list_photos too", /No pictures stored/.test(photos?.result?.content?.[0]?.text ?? ""));

const missing = await call("tools/call", { name: "get_file", arguments: { user, query: "a lease" } });
check("get_file on nothing is an answer, not a crash",
  Boolean(missing?.result?.content?.[0]?.text));

section("the same thing over stdio");

/* Spawned for real, because the stdio transport has its own framing and the
   bug it is prone to — a reply written to stdout that is not a reply — only
   shows up in a live process. */
const stdio = await new Promise((resolve) => {
  const child = spawn(process.execPath, ["src/mcp.mjs"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  let out = "";
  let stderr = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { stderr += d; });

  /* Two messages in one write, deliberately: clients batch, and a server that
     only handles one message per chunk looks fine until it does not. */
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n` +
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  /* And one split across writes, which is the other half of the same bug. */
  const half = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  child.stdin.write(half.slice(0, 12));
  setTimeout(() => child.stdin.write(`${half.slice(12)}\n`), 60);

  setTimeout(() => {
    child.kill();
    resolve({ out, stderr });
  }, 2500);
});

const lines = stdio.out.trim().split("\n").filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return { unparseable: l }; }
});
check("stdio speaks line-delimited JSON", lines.every((l) => !l.unparseable),
  lines.find((l) => l.unparseable)?.unparseable?.slice(0, 60));
check("two messages in one chunk both get handled", lines.some((l) => l.id === 1));
check("a message split across chunks still gets handled", lines.some((l) => l.id === 2));
/* The notification must not have produced a third line. */
check("and the notification produced no reply", lines.length === 2, `${lines.length} lines`);
check("logging goes to stderr, never stdout", /listening on stdio/.test(stdio.stderr));

/* Counted, not typed. A hardcoded total is wrong the moment a check is added,
   and a suite that misreports its own size is a poor advertisement for a
   project about not misreporting things. */
console.log(failures ? `\n${failures} of ${ran} check(s) failed\n` : `\nall ${ran} checks passed\n`);
process.exit(failures ? 1 : 0);

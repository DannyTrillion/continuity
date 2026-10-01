#!/usr/bin/env node
/**
 * The Telegram adapter, driven by a Telegram that isn't there.
 *
 *   node --env-file=.env tools/check-telegram.mjs
 *
 * The bots are the one part of this that cannot be opened in a browser, and
 * running the real token locally would fight the deployed bot for the same
 * long poll. So `fetch` is stood in for and the adapter is given a Telegram of
 * our own: it registers its commands, polls, gets a message, gets a button
 * tap, and we read back exactly what it tried to send.
 *
 * It costs one identity read and one write against the relayer — the same as
 * one real person saying hello once — and nothing else: `/menu` and `/help`
 * are answered by the command handler without the model.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const scratch = "/tmp/check-telegram";
mkdirSync(scratch, { recursive: true });
process.env.OUTBOX_PATH = join(scratch, "outbox.json");
process.env.PROVENANCE_PATH = join(scratch, "provenance.json");
process.env.FOLLOWUPS_PATH = join(scratch, "followups.json");
// Set outright, not defaulted: a local .env has PUBLIC_URL present but empty,
// which is how link buttons stay hidden on a laptop. This check is about what
// a deployed bot draws, so it is given a deployed bot's configuration.
process.env.PUBLIC_URL = "https://continuity-production-6084.up.railway.app";

let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  const said = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${said ? ` — ${said.replace(/\s+/g, " ").slice(0, 100)}` : ""}`);
};

/* ── a Telegram of our own ── */
const sent = [];              // everything the adapter tried to send
let queued = [];              // updates waiting to be polled
let nextMessageId = 100;
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/")) return realFetch(url, init);
  const method = u.split("/").pop();
  const body = init?.body ? JSON.parse(init.body) : {};
  sent.push({ method, body });

  const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { "Content-Type": "application/json" } });
  switch (method) {
    case "getMe": return ok({ id: 1, username: "checkbot", first_name: "Check" });
    case "setMyCommands": return ok(true);
    case "getUpdates": {
      const out = queued; queued = [];
      if (!out.length) await new Promise((r) => setTimeout(r, 60)); // don't spin
      return ok(out);
    }
    case "sendMessage": return ok({ message_id: nextMessageId++, chat: { id: body.chat_id } });
    case "editMessageText":
    case "editMessageReplyMarkup": return ok({ message_id: body.message_id });
    default: return ok(true);
  }
};

const { startTelegram } = await import("../src/adapters/telegram.mjs");
const { ACTIONS } = await import("../src/core/commands.mjs");

const CHAT = 555000111;
const FROM = { id: 999000001, username: "checkperson", first_name: "Check" };
const messagesSince = (n) => sent.slice(n).filter((c) => c.method === "sendMessage");
const waitFor = async (fn, ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 120)); }
  return false;
};

const bot = await startTelegram({ token: "fake-token" });

console.log("── it introduces itself to Telegram");
check("it asks who it is", sent.some((c) => c.method === "getMe"));
const cmds = sent.find((c) => c.method === "setMyCommands")?.body.commands ?? [];
check("it registers its commands", cmds.length >= 7, cmds.map((c) => "/" + c.command).join(" "));
check("the menu command is among them", cmds.some((c) => c.command === "menu"));
check("every registered command has a description", cmds.every((c) => c.description?.length > 3));
check("it only asks for what it handles",
  (sent.find((c) => c.method === "getUpdates")?.body.allowed_updates ?? []).join() === "message,callback_query");

console.log("\n── it fills in its own profile");
const setupCalls = sent.filter((c) => ["setMyDescription", "setMyShortDescription", "setChatMenuButton"].includes(c.method));
check("it writes the description people see before talking to it",
  (sent.find((c) => c.method === "setMyDescription")?.body.description ?? "").length > 120);
check("and a short one for its profile card", (() => {
  const short = sent.find((c) => c.method === "setMyShortDescription")?.body.short_description ?? "";
  return short.length > 20 && short.length <= 120;                       // Telegram's own cap
})(), sent.find((c) => c.method === "setMyShortDescription")?.body.short_description);
check("the description stays within Telegram's cap",
  (sent.find((c) => c.method === "setMyDescription")?.body.description ?? "").length <= 512);
check("it sets its menu button", setupCalls.some((c) => c.method === "setChatMenuButton"));

const scopes = sent.filter((c) => c.method === "setMyCommands");
check("commands are set for private chats and for groups", scopes.length >= 3, scopes.map((c) => c.body.scope?.type ?? "default"));
const group = scopes.find((c) => c.body.scope?.type === "all_group_chats")?.body.commands ?? [];
check("a group gets a shorter list", group.length > 0 && group.length < cmds.length, group.map((c) => "/" + c.command).join(" "));
check("and is never offered someone's private memories",
  !group.some((c) => ["whatyouknow", "forgetme", "link"].includes(c.command)));

console.log("\n── someone types /menu");
let mark = sent.length;
queued.push({ update_id: 1, message: { message_id: 1, chat: { id: CHAT }, from: FROM, text: "/menu" } });
const answered = await waitFor(() => messagesSince(mark).length > 0);
check("it answers", answered);
const menu = messagesSince(mark)[0]?.body ?? {};
check("it shows a typing indicator first", sent.slice(mark).some((c) => c.method === "sendChatAction"));
check("the answer carries buttons", Array.isArray(menu.reply_markup?.inline_keyboard), menu.text);
const buttons = (menu.reply_markup?.inline_keyboard ?? []).flat();
check("a handful of them, and not a wall", buttons.length >= 4 && buttons.length <= 6, buttons.map((b) => b.text));
check("including a way to pick how it works", buttons.some((b) => b.callback_data === "do:modes"));
check("each does something", buttons.every((b) => b.callback_data || b.url));
check("the tappable ones name a real action",
  buttons.filter((b) => b.callback_data).every((b) => ACTIONS[b.callback_data.replace(/^do:/, "")]?.say));
check("the link one opens the memory page", buttons.some((b) => /\/memory$/.test(b.url ?? "")), buttons.find((b) => b.url)?.url);
check("and its URL is whole", buttons.filter((b) => b.url).every((b) => /^https:\/\/[\w.-]+\.\w{2,}\//.test(b.url)), buttons.find((b) => b.url)?.url);

console.log("\n── someone taps a button");
mark = sent.length;
const tap = buttons.find((b) => b.callback_data === "do:help") ?? buttons.find((b) => b.callback_data);
queued.push({
  update_id: 2,
  callback_query: { id: "cb1", from: FROM, data: tap.callback_data, message: { message_id: 100, chat: { id: CHAT } } },
});
const tapped = await waitFor(() => messagesSince(mark).length > 0);
check("it acknowledges the tap", sent.slice(mark).some((c) => c.method === "answerCallbackQuery" && c.body.callback_query_id === "cb1"));
check("and answers it", tapped);
const after = messagesSince(mark)[0]?.body ?? {};
check("with the command that button stood for", /remember|Discord|Telegram/i.test(after.text ?? ""), (after.text ?? "").slice(0, 70));
check("and offers what to do next", Array.isArray(after.reply_markup?.inline_keyboard),
  (after.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text));

console.log("\n── a button that means nothing");
mark = sent.length;
queued.push({ update_id: 3, callback_query: { id: "cb2", from: FROM, data: "do:nonsense", message: { message_id: 100, chat: { id: CHAT } } } });
await new Promise((r) => setTimeout(r, 900));
check("is acknowledged and then ignored",
  sent.slice(mark).some((c) => c.method === "answerCallbackQuery") && messagesSince(mark).length === 0);

console.log("\n── an update with nothing in it");
mark = sent.length;
queued.push({ update_id: 4, message: { message_id: 2, chat: { id: CHAT }, from: FROM } });
await new Promise((r) => setTimeout(r, 900));
check("is skipped rather than answered", messagesSince(mark).length === 0);

bot.stop();
globalThis.fetch = realFetch;
console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);

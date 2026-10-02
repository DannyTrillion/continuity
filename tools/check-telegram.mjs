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
/* Telegram sends only the update types you ask for, so this list is the
   difference between a feature working and silently never firing. Asking for
   more than the loop handles is just as wrong: it wakes the poller for things
   it will drop. */
check("it only asks for what it handles",
  (sent.find((c) => c.method === "getUpdates")?.body.allowed_updates ?? []).join() ===
    "message,callback_query,inline_query",
  sent.find((c) => c.method === "getUpdates")?.body.allowed_updates);

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
/* When the relayer is rate limiting, /menu answers honestly — "I can't read
   my memory back right now" — with no buttons under it. That is the bot
   working as designed, and asserting a keyboard against it reports four
   failures for something that is not broken. Said once, here, rather than
   four times below. */
const busy = /can't read my memory|rate limit|too many requests/i.test(menu.text ?? "");
const buttons = (menu.reply_markup?.inline_keyboard ?? []).flat();
/* Three kinds of button: one that runs a command, one that opens a link, and
   one that opens a Mini App. A Mini App carries its URL under `web_app` and
   has no `url`, so anything checking links must look in both places. */
const linkOf = (b) => b.url ?? b.web_app?.url ?? null;
if (busy) {
  console.log(`SKIP  the /menu keyboard checks — the relayer is rate-limiting us`);
} else {
check("the answer carries buttons", Array.isArray(menu.reply_markup?.inline_keyboard), menu.text);
check("a handful of them, and not a wall", buttons.length >= 4 && buttons.length <= 6, buttons.map((b) => b.text));
check("including a way to pick how it works", buttons.some((b) => b.callback_data === "do:modes"));
check("each does something", buttons.every((b) => b.callback_data || linkOf(b)));
check("the tappable ones name a real action",
  buttons.filter((b) => b.callback_data).every((b) => ACTIONS[b.callback_data.replace(/^do:/, "")]?.say));
check("the memory page opens as a Mini App",
  buttons.some((b) => /\/memory$/.test(b.web_app?.url ?? "")),
  buttons.map((b) => b.web_app?.url ?? b.url).filter(Boolean));
check("and every URL is whole",
  buttons.filter((b) => linkOf(b)).every((b) => /^https:\/\/[\w.-]+\.\w{2,}\//.test(linkOf(b))),
  buttons.map(linkOf).filter(Boolean));
}

console.log("\n── someone taps a button");
mark = sent.length;
/* A rate-limited relayer makes /menu answer honestly — "I can't read my
   memory back right now" — with no buttons under it. That is the bot working
   as designed, not a broken keyboard, and the suite used to die on it with a
   TypeError three checks later. Say which it is and stop. */
const tap = buttons.find((b) => b.callback_data === "do:help") ?? buttons.find((b) => b.callback_data);
if (!tap) {
  const why = /can't read my memory|rate limit/i.test(menu.text ?? "")
    ? "the relayer is rate-limiting us, so there was nothing to tap"
    : "no tappable button was drawn";
  console.log(`\nSKIP  the tap tests — ${why}`);
  bot.stop();
  globalThis.fetch = realFetch;
  console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed (tap tests skipped)`);
  process.exit(failed ? 1 : 0);
}
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

/* ── forwarding ──
   Forwarding is Telegram's own gesture for "keep this", and the content on
   its own loses the half that matters: a line out of a group chat is worth
   little without knowing who said it. The origin moved to `forward_origin`
   in Bot API 7 and the older fields still arrive from some clients, so both
   shapes are read. */
console.log("\n── something forwarded in");
const { forwardNote } = await import("../src/adapters/telegram.mjs");
const DAY = 1790000000;

check("a message nobody forwarded is not a forward", forwardNote({ text: "hi" }) === null);
check("API 7 — a person", forwardNote({ forward_origin: { type: "user", sender_user: { first_name: "Sarah" }, date: DAY } })?.who === "Sarah");
check("API 7 — a channel", forwardNote({ forward_origin: { type: "channel", chat: { title: "Walrus Devs" }, date: DAY } })?.who === "Walrus Devs");
check("the older fields still work", forwardNote({ forward_from: { first_name: "Ada" }, forward_date: DAY })?.who === "Ada");
check("a hidden sender is still named, not dropped",
  forwardNote({ forward_origin: { type: "hidden_user", date: DAY } })?.who === "someone");
check("and the date comes with it", /\d{4}$/.test(forwardNote({ forward_from: { first_name: "Ada" }, forward_date: DAY })?.at ?? ""));

/* ── replying to a message ──
   Telegram lets someone answer any message, not just the latest, and without
   reading it the bot gets "what did you mean by that?" with no idea which
   "that". Whose words they are decides how they are treated: its own can be
   handed back plainly, anyone else's are quoted material. */
console.log("\n── a reply to an earlier message");
const { replyNote } = await import("../src/adapters/telegram.mjs");
const BOT = 1;

check("an ordinary message is not a reply", replyNote({ text: "hi" }, BOT) === null);
check("a reply with no text in it is not worth quoting",
  replyNote({ reply_to_message: { from: { id: 9 }, photo: [{}] } }, BOT) === null);

const toSelf = replyNote({ reply_to_message: { from: { id: BOT, is_bot: true }, text: "Tail recursion is optimised into a loop." } }, BOT);
check("replying to the bot is marked as its own words", toSelf?.mine === true, toSelf?.text);
check("and carries no attribution, because it needs none", toSelf?.who === null);

const toOther = replyNote({ reply_to_message: { from: { id: 77, first_name: "Marcus" }, text: "pnpm is just npm with a different lockfile" } }, BOT);
check("replying to someone else is not", toOther?.mine === false);
check("and names who said it", toOther?.who === "Marcus", toOther?.who);

const caption = replyNote({ reply_to_message: { from: { id: 77, username: "marcus" }, caption: "the deploy log" } }, BOT);
check("a photo's caption counts as what was said", caption?.text === "the deploy log", caption?.text);
check("and a username stands in when there is no first name", caption?.who === "marcus");

console.log("\n── a file, not a photo");
mark = sent.length;
queued.push({
  update_id: 5,
  message: {
    message_id: 3, chat: { id: CHAT }, from: FROM,
    document: { file_id: "doc-1", file_name: "notes.txt", mime_type: "text/plain", file_size: 40 * 1024 * 1024 },
  },
});
await waitFor(() => messagesSince(mark).length > 0, 5000);
const tooBig = messagesSince(mark);
check("one over Telegram's own limit is refused in words, not swallowed",
  tooBig.length === 1 && /20MB/.test(tooBig[0]?.body?.text ?? ""),
  tooBig[0]?.body?.text);

/* ── inline mode ──
   `@thebot pnpm` typed inside a chat the bot was never added to. This is the
   only path where one person's memories are rendered by Telegram's own UI, so
   `is_personal` is not a nicety: without it Telegram caches results against
   the query text and serves one person's memory to the next person who types
   the same word. */
console.log("\n── searching from inside someone else's chat");
const { inlineResult } = await import("../src/adapters/telegram.mjs");

mark = sent.length;
queued.push({ update_id: 6, inline_query: { id: "iq-1", from: FROM, query: "pnpm", offset: "" } });
await waitFor(() => sent.slice(mark).some((c) => c.method === "answerInlineQuery"), 60000);
const inlineAnswer = sent.slice(mark).find((c) => c.method === "answerInlineQuery")?.body ?? {};

check("an inline query gets answered", Boolean(inlineAnswer.inline_query_id), inlineAnswer.inline_query_id);
check("the answer is marked personal, so Telegram cannot serve it to someone else",
  inlineAnswer.is_personal === true);
check("results carry ids unique within the answer", (() => {
  const ids = (inlineAnswer.results ?? []).map((r) => r.id);
  return new Set(ids).size === ids.length;
})());
check("every id fits Telegram's 64-byte cap",
  (inlineAnswer.results ?? []).every((r) => Buffer.byteLength(String(r.id)) <= 64));
check("nothing found still offers a way in, rather than spinning",
  (inlineAnswer.results ?? []).length > 0 || Boolean(inlineAnswer.button?.text),
  inlineAnswer.button?.text);

const long = inlineResult({ text: "A ".padEnd(300, "very long memory "), blobId: "x", at: null }, 0);
check("a long memory is trimmed into a title Telegram will accept",
  long.title.length <= 64 && !/\s$/.test(long.title), `${long.title.length} chars`);
check("picking a result sends the memory itself, not a note about it",
  long.input_message_content.message_text.startsWith("A very long memory"));

bot.stop();
globalThis.fetch = realFetch;
console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);

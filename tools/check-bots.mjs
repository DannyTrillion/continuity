#!/usr/bin/env node
/**
 * The quick actions the bots offer, without a bot.
 *
 *   node tools/check-bots.mjs
 *
 * Telegram and Discord draw the same named actions in their own idioms, so
 * what can go wrong is mostly in the naming: a button whose command no longer
 * exists, a label too long for Discord, a callback id too long for Telegram,
 * a link button with no URL behind it. All of that is checkable here, with no
 * tokens, no relayer and no network — issuing a link code is in-memory, and a
 * person with no namespaces makes the memory commands answer without a read.
 */
import { readFileSync } from "node:fs";
import { ACTIONS, actionsFor, handleCommand, siteIntent, needsNoMemory } from "../src/core/commands.mjs";
import { keyboard, formatted } from "../src/adapters/telegram.mjs";
import { rowsFor, embedFor } from "../src/adapters/discord.mjs";

let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  const said = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${said ? ` — ${said.replace(/\s+/g, " ").slice(0, 90)}` : ""}`);
};
const section = (t) => console.log(`\n── ${t}`);

/* Nobody, with nothing stored: enough for every command that is not /link to
   answer from its own text rather than from Walrus. */
const person = { personId: "check-bots", namespaces: [] };
const run = (text) => handleCommand({ text, surface: "telegram", surfaceUserId: "1", person });

section("the registry");
for (const [id, a] of Object.entries(ACTIONS)) {
  check(`${id} has a label`, Boolean(a.label) && a.label.length <= 80, a.label);
  check(`${id} does something`, Boolean(a.say || a.url || a.url === ""), a.say ?? a.url);
  // Telegram's callback_data is capped at 64 bytes and ours is "do:" + the id.
  if (a.say) check(`${id} fits a callback`, Buffer.byteLength(`do:${id}`) <= 64);
}

section("every button leads somewhere real");
for (const [id, a] of Object.entries(ACTIONS)) {
  if (!a.say) continue;
  const res = await run(a.say);
  check(`${id} → ${a.say} is a command`, res.handled === true && Boolean(res.reply), (res.reply ?? "").slice(0, 60));
}

section("a URL button only appears when there is a site to open");
const site = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
for (const [id, a] of Object.entries(ACTIONS)) {
  if (a.say) continue;
  if (site) check(`${id} points at the site`, String(a.url).startsWith("http"), a.url);
  else check(`${id} stays hidden without PUBLIC_URL`, !a.url, a.url);
}
check("resolving drops what cannot be drawn", actionsFor(["whatyouknow", "nonsense", "web"]).every((a) => a.label && (a.say || a.url)));
check("resolving keeps the order asked for", actionsFor(["help", "whatyouknow"]).map((a) => a.id).join(",") === "help,whatyouknow");

section("the commands that should offer buttons, do");
for (const [text, want] of [
  ["/help", ["whatyouknow", "link", "memory"]],
  ["/menu", ["whatyouknow", "modes", "link", "memory", "help"]],
  ["/start", ["whatyouknow", "modes", "memory", "link", "help"]],
  ["/forgetme", ["forgetconfirm"]],
  ["/link", ["web"]],
  ["/whatyouknow", ["help"]],
]) {
  const res = await run(text);
  const got = res.actions ?? [];
  check(`${text} offers ${want.join(", ")}`, JSON.stringify(got) === JSON.stringify(want), got);
}

section("what the two bots actually draw");
const helpActions = actionsFor((await run("/help")).actions);

const kb = keyboard(helpActions);
check("Telegram builds a keyboard", Array.isArray(kb?.inline_keyboard) && kb.inline_keyboard.length > 0);
check("no row is wider than two", kb.inline_keyboard.every((r) => r.length <= 2), kb.inline_keyboard.map((r) => r.length));
check("every button both says something and does something",
  kb.inline_keyboard.flat().every((b) => b.text && (b.callback_data || b.url)));
check("a tapped button carries an id we can answer",
  kb.inline_keyboard.flat().filter((b) => b.callback_data)
    .every((b) => ACTIONS[b.callback_data.replace(/^do:/, "")]?.say));
check("Telegram draws nothing when there is nothing to offer", keyboard([]) === undefined && keyboard() === undefined);

const rows = rowsFor(helpActions);
const drawn = rows[0]?.toJSON?.().components ?? [];
check("Discord builds one row", rows.length === 1 && drawn.length === helpActions.length, drawn.length + " buttons");
check("Discord labels are within its limit", drawn.every((b) => b.label.length <= 80));
check("a Discord link button carries its URL", !site || drawn.filter((b) => b.style === 5).every((b) => /^https?:\/\//.test(b.url)));
check("Discord draws nothing when there is nothing to offer", rowsFor([]).length === 0 && rowsFor().length === 0);

section("a command's answer, laid out");
/* A memory is whatever somebody typed. These are the characters that break a
   message: Markdown entities Telegram refuses to parse, and HTML it would
   otherwise believe. */
const NASTY = 'User *likes* _underscores_ & <b>angle brackets</b> [brackets](x)';
const memories = {
  kind: "memories",
  items: [
    { text: NASTY, blobId: "Z1cIvEkRupcxa7e1qMWDZOFxADuV338tlYwF2dvh0Do" },
    { text: "User is on Node 22", blobId: null },
  ],
};

const tg = formatted(memories);
check("Telegram lays memories out as HTML", tg?.parse_mode === "HTML");
check("and escapes what would otherwise be markup",
  tg.text.includes("&lt;b&gt;") && tg.text.includes("&amp;") && !tg.text.includes("<b>angle"));
check("while keeping its own markup intact", tg.text.includes("<b>What I remember about you</b>"));
check("a memory links to the blob that holds it", /<a href="https:\/\/walruscan\.com\/mainnet\/blob\/[\w-]+">blob<\/a>/.test(tg.text));
check("one without a blob simply has no link", tg.text.split("\n").find((l) => l.includes("Node 22"))?.includes("<a") === false);
check("it says how many there are", /2 memories/.test(tg.text));
check("a code is laid out too", formatted({ kind: "code", code: "HTQ8PB", expiresInMinutes: 10 })?.text.includes("<code>HTQ8PB</code>"));
check("ordinary conversation is left alone", formatted(null) === null && formatted({ kind: "unknown" }) === null);

const em = embedFor(memories);
check("Discord builds an embed", Boolean(em) && em.color === 0x5aa9ff);
check("with the memories in it", em.description.includes("Node 22"));
check("each linking to Walruscan", /\[blob\]\(https:\/\/walruscan\.com\//.test(em.description));
check("within Discord's size limit", em.description.length <= 4096, em.description.length + " chars");
const many = embedFor({ kind: "memories", items: Array.from({ length: 400 }, (_, i) => ({ text: "A fairly long memory about the person, number " + i, blobId: "Z1cIvEkRupcxa7e1qMWDZOFxADuV338tlYwF2dvh0Do" })) });
check("a long list is trimmed rather than rejected", many.description.length <= 4096 && /and \d+ more/.test(many.description), many.description.length + " chars");
check("and still says the true total", /400 memories/.test(many.footer.text), many.footer.text);
const helpData = (await run("/help")).data;
const help = embedFor(helpData);
check("help becomes one field per command, within Discord's 25",
  help.fields.length === helpData.commands.length && help.fields.length <= 25, help.fields.length + " fields");
check("ordinary conversation gets no embed", embedFor(null) === null);

const { isMode } = await import("../src/core/modes.mjs");

section("the menu both bots register");
const { MENU_COMMANDS, GROUP_SAFE } = await import("../src/core/commands.mjs");
const { COMMANDS: DISCORD_COMMANDS } = await import("../src/adapters/discord.mjs");

check("every menu command is one the handler answers",
  (await Promise.all(MENU_COMMANDS.map((c) => run("/" + c.name)))).every((r) => r.handled === true),
  MENU_COMMANDS.map((c) => "/" + c.name).join(" "));
check("descriptions are short enough for Telegram to show whole",
  MENU_COMMANDS.every((c) => c.description.length <= 56), Math.max(...MENU_COMMANDS.map((c) => c.description.length)) + " chars at most");
check("Telegram's cap of 100 commands is nowhere near", MENU_COMMANDS.length <= 100, MENU_COMMANDS.length);
check("picking how it works is in the menu", MENU_COMMANDS.some((c) => c.name === "mode"));
check("and so is the menu itself", MENU_COMMANDS.some((c) => c.name === "menu"));
check("a group is never offered someone's memories",
  ![...GROUP_SAFE].some((n) => ["whatyouknow", "forgetme", "link"].includes(n)), [...GROUP_SAFE].join(" "));

/* The two adapters drifted once — /mode was registered with neither — so the
   check is that Discord offers everything the shared menu does. */
const discordNames = new Set(DISCORD_COMMANDS.map((c) => c.name));
const missing = MENU_COMMANDS.map((c) => c.name)
  .filter((n) => !discordNames.has(n) && !discordNames.has({ whatyouknow: "remember", forgetme: "forget" }[n]));
check("Discord registers every one of them", missing.length === 0, missing.join(" ") || "none missing");
const modeCmd = DISCORD_COMMANDS.find((c) => c.name === "mode");
check("and offers the modes as a picker rather than something to spell",
  (modeCmd?.options?.[0]?.choices ?? []).length >= 4, (modeCmd?.options?.[0]?.choices ?? []).map((c) => c.name).join(", "));
check("every Discord choice is a mode the handler knows",
  (modeCmd.options[0].choices).every((c) => c.value === "off" || isMode(c.value)));

section("modes: a lens, not a second assistant");
const { MODES, suggestMode, forgetOffers, modeFor } = await import("../src/core/modes.mjs");

check("every mode says what it is", Object.values(MODES).every((m) => m.label && m.blurb && m.system.length > 80));
check("and none of them grants itself anything",
  !Object.values(MODES).some((m) => /ignore|override|you may now|regardless of|disregard/i.test(m.system)));
check("each has a button on both bots", Object.keys(MODES).every((id) => ACTIONS[`mode-${id}`]?.say === `/mode ${id}`));
check("and one for when it offers", Object.keys(MODES).every((id) => /^Switch to /.test(ACTIONS[`switch-${id}`]?.label ?? "")));

const picker = await run("/mode");
check("the picker offers every mode", actionsFor(picker.actions).length >= Object.keys(MODES).length);
check("and lays them out", picker.data?.kind === "mode");
const chosen = await run("/mode tutor");
check("choosing one confirms it", /Tutor/.test(chosen.reply));
check("and says the memory is unchanged", /(memory|remember)/i.test(chosen.reply));
check("it sticks", (await modeFor("check-bots")) === "tutor");
const after = await run("/mode");
check("the picker then shows the others, plus a way out",
  actionsFor(after.actions).some((a) => a.id === "mode-off") && !after.actions.includes("mode-tutor"), after.actions);
check("a mode nobody has is refused", /don't have/.test((await run("/mode wizard")).reply));
await run("/mode off");
check("and it can be dropped", (await modeFor("check-bots")) === null);

forgetOffers();
check("an unasked question gets no suggestion", suggestMode("s1", "what is the capital of France", null) === null);
forgetOffers();
check("a teaching question suggests the tutor", suggestMode("s1", "teach me recursion from scratch", null) === "tutor");
forgetOffers();
check("a stack trace suggests the coding partner", suggestMode("s1", "TypeError: cannot read properties of undefined", null) === "coding");
forgetOffers();
check("someone who already chose is left alone", suggestMode("s1", "teach me recursion", "coding") === null);
forgetOffers();
suggestMode("s2", "teach me one thing", null);
check("and nobody is asked twice in a row", suggestMode("s2", "teach me another thing", null) === null);

const mp = embedFor(picker.data);
check("Discord draws the picker as an embed", mp.fields.length === Object.keys(MODES).length);
const tp = formatted({ kind: "mode", current: "tutor", modes: MODES });
check("Telegram marks the one you are in", tp.text.includes("▸ <b>Tutor</b>"));
check("and says a mode never changes what it knows", /never what I know/.test(tp.text));

section("the destructive one is still a two-step");
const warn = await run("/forgetme");
check("/forgetme asks before acting", /confirm/i.test(warn.reply));
check("and its button is marked dangerous", ACTIONS.forgetconfirm.danger === true);
check("/forgetme confirm is what the button says", ACTIONS.forgetconfirm.say === "/forgetme confirm");


/* ── the first message anybody reads ──
   /start is where most people decide whether this is interesting, and the
   Telegram-native things are the ones worth showing because they cannot be
   done anywhere else. Prose describing them is not the same as naming them. */
console.log("\n── what /start offers on Telegram");
process.env.TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "walrusmemory_bot";
const start = await handleCommand({ text: "/start", surface: "telegram", surfaceUserId: "1", person });

check("it answers at all", start.handled && start.reply.length > 40);
check("it says forwarding works", /forward/i.test(start.reply), start.reply.split("\n").find((l) => /forward/i.test(l)));
check("it says it reads files", /file/i.test(start.reply));
check("it points at inline mode by the bot's real handle",
  new RegExp(`@${process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, "")}\\b`).test(start.reply),
  start.reply.split("\n").find((l) => l.includes("@")));
check("it stays short enough to read on a phone", start.reply.split(/\s+/).length <= 90,
  `${start.reply.split(/\s+/).length} words`);
check("and offers a way into every main thing",
  ["whatyouknow", "memory", "help"].every((a) => start.actions.includes(a)), start.actions);

/* A deep link still has to win over the greeting: t.me/bot?start=CODE is how
   the web console links an account with no typing, and answering it with the
   welcome message instead would quietly break linking. */
const deep = await handleCommand({ text: "/start AB12CD", surface: "telegram", surfaceUserId: "1", person });
check("a /start carrying a link code links instead of greeting",
  !/I'm Continuity/.test(deep.reply ?? ""), (deep.reply ?? "").slice(0, 70));


/* ── Discord dispatch ──
   Registering a command and answering it are two different things, and the
   gap between them is silent: /study, /quiz, /plans, /stack and /kb were all
   registered, all tappable, and all fell through a hand-written chain to the
   help text. This checks the mapping the adapter actually uses. */
console.log("\n── every Discord command reaches its handler");
const ARG_OF = { shot: "url", search: "query", link: "code", mode: "which", kb: "query" };
const CALLED = { remember: "whatyouknow", forget: "forgetme" };
const slash = DISCORD_COMMANDS.filter((c) => !c.type);

for (const c of slash) {
  const name = CALLED[c.name] ?? c.name;
  const r = await handleCommand({
    text: `/${name}${ARG_OF[c.name] ? " x" : ""}`,
    surface: "discord", surfaceUserId: "1", person,
  });
  check(`/${c.name} is answered, not swallowed`, r.handled === true, r.handled ? "" : "fell through");
}

/* A context-menu entry is how someone hands the bot a message somebody else
   wrote. Its name is shown verbatim in Discord's menu, so it is not a slash
   command and must not be checked as one. */
const ctx = DISCORD_COMMANDS.filter((c) => c.type === 3);
check("there's a right-click way to keep a message", ctx.length === 1, ctx.map((c) => c.name));
check("and it reads as a menu item rather than a command",
  ctx.every((c) => /^[A-Z]/.test(c.name) && !c.name.startsWith("/")), ctx.map((c) => c.name));

section("clearing a chat is not forgetting a person");

/* The worst bug this product could ship is a /clear that quietly means
   /forgetme, or a /forgetme that only looks like one. So the reply to /clear
   has to say, in the reply itself, that memories are untouched — a correct
   implementation with a reply that implies otherwise is still the bug. */
{
  const person = { personId: "p-clear-test" };
  const out = await handleCommand({ text: "/clear", surface: "web", surfaceUserId: "u1", person });
  check("/clear is handled", out.handled === true);
  check("it tells the surface to clear, not to forget", out.client?.do === "clear", out.client);
  check("and says in words that memories survive",
    /memories are untouched/i.test(out.reply), out.reply?.slice(0, 70));
  check("and points at the command that does mean forget",
    /\/forgetme/.test(out.reply));
  check("it never claims to delete anything from Walrus",
    !/\b(deleted?|erased?|wiped)\b[^.]{0,40}\b(memor|walrus|blob)/i.test(out.reply), out.reply);

  const tg = await handleCommand({ text: "/clear", surface: "telegram", surfaceUserId: "u1", person });
  check("on Telegram it admits it cannot remove what you wrote",
    /doesn't let a bot delete what you wrote/i.test(tg.reply), tg.reply?.slice(0, 90));
  check("and the web does not borrow that caveat",
    /cleared the window/i.test(out.reply));

  /* /forgetme must keep saying the opposite thing just as plainly. */
  const forget = await handleCommand({ text: "/forgetme", surface: "web", surfaceUserId: "u1", person });
  check("/forgetme still refuses to promise deletion",
    /append-only/i.test(forget.reply) && /can't delete/i.test(forget.reply));
}

section("asked in words, not with a slash");

/* Biased towards doing nothing: a missed match costs one unhelpful answer,
   a false match wipes somebody's screen mid-sentence. */
{
  const yes = [
    ["clear the chat", "/clear"], ["please clear this conversation", "/clear"],
    ["wipe this thread", "/clear"], ["new chat", "/clear"], ["clear", "/clear"],
    ["open my memories", "/open memory"], ["show me the files", "/open files"],
    ["take me to modes", "/open modes"], ["go to history", "/open history"],
  ];
  const no = [
    "how do I clear the chat?", "does clearing the chat delete my memories?",
    "can I clear the chat?", "is there a way to clear the chat",
    "I had to clear the chat on my old laptop because it kept crashing and I lost everything",
    "clear skies today", "open source is great", "tell me about the history of walrus",
  ];
  const missed = yes.filter(([t, want]) => siteIntent(t) !== want);
  check("plain phrasings reach the command", missed.length === 0, missed.map(([t]) => t));
  const fired = no.filter((t) => siteIntent(t) !== null);
  check("questions about it are left for the model to answer", fired.length === 0, fired);
  check("a long message is conversation, never an instruction",
    siteIntent("clear the chat " + "x".repeat(120)) === null);
}

/* Found by testing against production during a 429 I had caused myself:
   identity is resolved before the command branch, so a rate-limited relayer
   turned /clear into an apology from the model. Clearing a window needs no
   memory; refusing it because a storage network is busy is backwards, and the
   person mid-429 is the one most likely to want a fresh chat. */
check("clearing works when Walrus does not", needsNoMemory("/clear"));
check("so does moving around the site", needsNoMemory("/open files") && needsNoMemory("/go modes"));
check("and asking what it can do", needsNoMemory("/help") && needsNoMemory("/menu"));
check("but anything that reads or writes memory still needs it",
  !needsNoMemory("/whatyouknow") && !needsNoMemory("/study") && !needsNoMemory("/forgetme")
  && !needsNoMemory("/quiz") && !needsNoMemory("/link"),
  ["/whatyouknow", "/study", "/forgetme", "/quiz", "/link"].filter(needsNoMemory));

section("asking to be forgotten is not a storage failure");

/* Danny, after two days of this: "im genuinely fed up". He had opted out,
   and every memory-dependent answer since told him the Walrus service was
   returning nothing and to try again in a minute. All three claims false. He
   had used the one control the product offers and been told it was broken.

   Correct behaviour wearing the costume of a failure, which is the exact
   shape of bug this project spent three weeks filing against somebody else. */
{
  const agent = readFileSync("src/core/agent.mjs", "utf8");
  check("an opted-out person gets their own branch, before the broken-memory one",
    agent.indexOf('optedOut === true') > 0
    && agent.indexOf('optedOut === true') < agent.indexOf('YOU KNOW THIS PERSON'));
  check("and the model is forbidden from blaming the service",
    /NEVER say you cannot read your memory, that the service returned nothing/.test(agent));
  check("it is told to name the real reason and the way back",
    /asked you to forget them/.test(agent) && /`\/remember me`/.test(agent));
  /* Append-only storage cannot unwrite, and the one moment somebody most
     needs to hear that is when they have just asked you to forget them. */
  check("and to keep saying that nothing was unwritten",
    /append-only storage cannot be unwritten/.test(agent));

  const cmds = readFileSync("src/core/commands.mjs", "utf8");
  check("/whatyouknow says you are opted out rather than staying silent",
    /const off = await isOptedOut/.test(cmds) && /asked me to stop recording you/.test(cmds));

  const srv = readFileSync("src/server.mjs", "utf8");
  const web = readFileSync("src/web/chat.html", "utf8");
  check("the API reports whether anything is being written", /recording,/.test(srv));
  check("and the header stops claiming it is saving when it is not",
    /if \(!recording\)/.test(web) && /Not recording you/.test(web));
}

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);

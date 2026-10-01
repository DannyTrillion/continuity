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
import { ACTIONS, actionsFor, handleCommand } from "../src/core/commands.mjs";
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
  ["/start", ["whatyouknow", "link", "help"]],
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

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);

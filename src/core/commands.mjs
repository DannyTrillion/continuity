/**
 * Surface-agnostic slash commands.
 *
 * Telegram, Discord and the web chat all route text through here first, so
 * linking behaves identically everywhere and lives in one place.
 */

import { issueLinkCode, redeemLinkCode, resolvePerson, setOptOut } from "./identity.mjs";
import { recall } from "./memory.mjs";
import { searchWeb, screenshotUrl } from "./web.mjs";
import { MODES, isMode, modeFor, setMode } from "./modes.mjs";

/**
 * Where the website is, if it is anywhere.
 *
 * Railway names the domain it gave us whether or not anyone remembered to set
 * PUBLIC_URL, so a deploy that forgot it still gets working link buttons
 * rather than silently dropping them. Empty on a laptop, which is right: a
 * button pointing at a site nobody else can reach is worse than no button.
 */
const SITE = (
  process.env.PUBLIC_URL?.trim() ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim()}` : "")
).replace(/\/+$/, "");

/**
 * What to offer next — named here, drawn by each surface in its own idiom.
 *
 * Telegram makes these inline buttons, Discord makes them a row of components,
 * and the web could make them chips. Naming them in one place is what keeps
 * the three bots feeling like one product: a command added here appears as a
 * button everywhere, and nobody has to remember to update two adapters.
 *
 * An action either says something (as if the person had typed it) or opens a
 * URL. A URL action disappears on its own when PUBLIC_URL is not set, so a
 * local run never offers a button that goes nowhere.
 */
export const ACTIONS = {
  whatyouknow:   { label: "What do you know about me?", say: "/whatyouknow" },
  link:          { label: "Connect another app", say: "/link" },
  help:          { label: "What can you do?", say: "/help" },
  menu:          { label: "Quick actions", say: "/menu" },
  forgetconfirm: { label: "Yes, stop recording me", say: "/forgetme confirm", danger: true },
  web:           { label: "Open the web chat", url: SITE && `${SITE}/chat` },
  /* `webApp` asks Telegram to open this inside the app as a Mini App rather
     than bouncing out to a browser. The memory page is the one worth it: it
     is where someone checks what is stored and corrects it, and losing the
     chat to do that is what stops people doing it at all. Surfaces that have
     no such thing — Discord — see an ordinary link and ignore the flag. */
  memory:        { label: "See everything I remember", url: SITE && `${SITE}/memory`, webApp: true },
  docs:          { label: "How it works", url: SITE && `${SITE}/docs` },
};

/* One action per mode, built from the registry so a mode added there becomes
   a button on both bots without either adapter changing. Two of them: the
   plain name for the picker, and a fuller sentence for when the assistant is
   the one offering. */
for (const [id, m] of Object.entries(MODES)) {
  ACTIONS[`mode-${id}`] = { label: m.label, say: `/mode ${id}` };
  ACTIONS[`switch-${id}`] = { label: `Switch to ${m.label}`, say: `/mode ${id}` };
}
ACTIONS["mode-off"] = { label: "No mode", say: "/mode off" };
ACTIONS["modes"] = { label: "How I work", say: "/mode" };

/** Resolve names to what a surface needs, dropping any that cannot be drawn. */
export const actionsFor = (names) =>
  (names ?? [])
    .map((id) => ({ id, ...ACTIONS[id] }))
    .filter((a) => a.label && (a.say || a.url));

/**
 * What it can do, listed once.
 *
 * The help text is built from this rather than written beside it: a command
 * list kept in prose drifts from the one kept in code, and the stale one is
 * always the one people read. Discord renders these as embed fields and
 * Telegram as lines, from the same source.
 */
const COMMAND_LIST = [
  ["/menu", "The things I do most, as buttons"],
  ["/mode", "Pick how I work: tutor, coding partner, planner, support"],
  ["/link", "Get a code to connect this account to another app"],
  ["/link CODE", "Redeem a code from another app"],
  ["/whatyouknow", "Show what I remember about you"],
  ["/search WORDS", "Look something up on the web"],
  ["/shot URL", "Send back a screenshot of a page"],
  ["/forgetme", "Stop recording me"],
  ["/help", "This message"],
];

/**
 * The menu both bots register, in the order it should read.
 *
 * Telegram shows this the moment someone types "/", and Discord lists it in
 * the command picker — so this IS the bot's menu, and it was drifting: two
 * adapters each kept their own copy and `/mode` ended up in neither. Ordered
 * deliberately: the things you do, then what it knows, then how to reach it,
 * then the tools, then the way out.
 *
 * Descriptions stay short because Telegram truncates them mid-word.
 */
export const MENU_COMMANDS = [
  { name: "menu", description: "Everything I do, as buttons" },
  { name: "mode", description: "How I work: tutor, coding, planner, support" },
  { name: "whatyouknow", description: "What I remember about you" },
  { name: "link", description: "Connect Discord or the web chat" },
  { name: "search", description: "Look something up on the web" },
  { name: "shot", description: "Screenshot a web page" },
  { name: "forgetme", description: "Stop recording me" },
  { name: "help", description: "What I can do" },
];

/* A room full of people is no place to print one person's memories, so a
   group is offered only what is safe to answer in public. */
export const GROUP_SAFE = new Set(["search", "shot", "help", "menu"]);

const INTRO = "I remember you across Discord, Telegram and the web chat.\n\n" +
  "Just talk to me normally — anything worth keeping, I'll keep. Paste a link and " +
  "I'll read it before I answer.";

const HELP = `${INTRO}\n\n${COMMAND_LIST.map(([c, what]) => `${c} — ${what[0].toLowerCase()}${what.slice(1)}`).join("\n")}`;

export async function handleCommand({ text, surface, surfaceUserId, person }) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd.toLowerCase()) {
    case "/help":
      return {
        handled: true,
        reply: HELP,
        // Named, not drawn: Discord makes an embed of this, Telegram a list.
        data: { kind: "help", intro: INTRO, commands: COMMAND_LIST },
        actions: ["whatyouknow", "link", "memory"],
      };

    // The same things the slash menu offers, as buttons, for anyone who would
    // rather tap than remember a command.
    case "/menu":
      return {
        handled: true,
        reply: "One tap each:",
        actions: ["whatyouknow", "modes", "link", "memory", "help"],
      };

    case "/start": {
      // Telegram deep links (t.me/bot?start=CODE) arrive here as "/start CODE",
      // so scanning the QR in the web console links the two accounts with no
      // typing at all.
      if (/^[A-Z0-9]{6}$/i.test(arg)) {
        return handleCommand({ text: `/link ${arg}`, surface, surfaceUserId, person });
      }
      // Arriving cold from the website, with nothing to carry over.
      return {
        handled: true,
        reply:
          "Hey. I'm Continuity — I remember the people I talk to, here and on Discord and the web chat.\n\n" +
          "Just talk to me normally. Anything worth keeping, I'll keep.\n\n" +
          "Already been chatting on the website? Send `/link` there, then send me `/link` and the code, " +
          "and everything you told it comes with you.",
        actions: ["whatyouknow", "link", "help"],
      };
    }

    /**
     * A mode is a manner, not a second assistant: the memories are the same
     * either way. Stored, so choosing one here chooses it everywhere.
     */
    case "/mode": {
      const want = arg.toLowerCase().replace(/^\/+/, "");
      const current = await modeFor(person.personId).catch(() => null);

      if (want === "off" || want === "none" || want === "clear") {
        setMode(person.personId, null);
        return {
          handled: true,
          reply: "Back to no particular mode — I'll answer as a generalist. Same memory either way.",
          actions: Object.keys(MODES).map((id) => `mode-${id}`),
        };
      }

      if (isMode(want)) {
        setMode(person.personId, want);
        return {
          handled: true,
          reply:
            `**${MODES[want].label}** mode. ${MODES[want].blurb}.\n\n` +
            `This follows you — it's the same on Telegram, Discord and the web. ` +
            `Nothing about what I remember changes; only how I answer. Say \`/mode off\` to drop it.`,
          data: { kind: "mode", current: want, modes: MODES },
          actions: ["whatyouknow", "mode-off"],
        };
      }

      if (want) {
        return {
          handled: true,
          reply: `I don't have a "${arg}" mode. Pick one of these:`,
          data: { kind: "mode", current, modes: MODES },
          actions: Object.keys(MODES).map((id) => `mode-${id}`),
        };
      }

      return {
        handled: true,
        reply: current
          ? `You're in **${MODES[current].label}** mode — ${MODES[current].blurb.toLowerCase()}. Switch any time:`
          : "No mode set, so I answer as a generalist. Pick one and I'll work that way everywhere:",
        data: { kind: "mode", current, modes: MODES },
        actions: [...Object.keys(MODES).filter((id) => id !== current).map((id) => `mode-${id}`),
                  ...(current ? ["mode-off"] : [])],
      };
    }

    case "/link": {
      if (!arg) {
        const { code, expiresInMinutes } = await issueLinkCode(person.personId, surface);
        return {
          handled: true,
          reply:
            `Your link code is **${code}** — it expires in ${expiresInMinutes} minutes.\n\n` +
            `Send \`/link ${code}\` from another surface (Discord, Telegram or the web chat) ` +
            `and I'll know it's the same you. Everything you've told me on either one carries over.`,
          data: { kind: "code", code, expiresInMinutes },
          actions: ["web"],
        };
      }
      const res = await redeemLinkCode(surface, surfaceUserId, arg);
      if (!res.ok) {
        const why = {
          "unknown-code": "I don't recognise that code. Codes are six characters, and they expire after 10 minutes.",
          expired: "That code has expired. Run /link again on the other surface for a fresh one.",
          "same-surface": "That code was issued on this same surface — redeem it somewhere else.",
        };
        return { handled: true, reply: why[res.reason] ?? "That didn't work." };
      }
      if (res.alreadyLinked) return { handled: true, reply: "These accounts are already linked." };
      return {
        handled: true,
        reply:
          "Linked. This account and the one that issued the code are the same person to me now — " +
          "and nothing either of you told me is lost, both histories carry over.",
        relink: true,
        actions: ["whatyouknow", "memory"],
      };
    }

    case "/shot":
    case "/screenshot": {
      if (!arg) return { handled: true, reply: "Give me a link to shoot, like `/shot https://walrus.xyz`." };
      const shot = await screenshotUrl(arg, { fullPage: /\bfull\b/i.test(rest.join(" ")) });
      if (!shot.ok) return { handled: true, reply: shot.error };
      return {
        handled: true,
        reply: shot.url,
        image: { png: shot.png, name: "screenshot.png" },
      };
    }

    case "/search": {
      if (!arg) return { handled: true, reply: "What should I look up? Try `/search walrus storage epochs`." };
      const found = await searchWeb(arg, { limit: 5 });
      if (!found.ok) return { handled: true, reply: found.error };
      const lines = found.results.map((r) => `• ${r.title}\n  ${r.url}`).join("\n");
      return {
        handled: true,
        reply:
          (found.weak ? "Only got encyclopedia entries for that:\n\n" : "") +
          lines +
          "\n\nSend me one of those links and I'll read it properly.",
      };
    }

    case "/whatyouknow": {
      // Every namespace this person owns — including accounts merged in by
      // linking, or anything said before the link would silently vanish.
      const sets = await Promise.all(
        person.namespaces.map((ns) =>
          recall(ns, arg || "anything about this person", { limit: 12, maxTokens: 900 }),
        ),
      );
      const hits = sets.flat().sort((a, b) => a.distance - b.distance);
      if (!hits.length) {
        return {
          handled: true,
          reply: "Nothing yet — we haven't talked about anything worth keeping.",
          actions: ["help"],
        };
      }
      const lines = hits.map((h) => `• ${h.text}`).join("\n");
      return {
        handled: true,
        reply: `Here's what I have:\n\n${lines}`,
        data: {
          kind: "memories",
          items: hits.map((h) => ({ text: h.text, blobId: h.blob_id ?? null })),
        },
        actions: ["memory", "link"],
      };
    }

    case "/forgetme": {
      if (arg.toLowerCase() === "confirm") {
        await setOptOut(person.personId, true);
        return {
          handled: true,
          reply:
            "Done — I've stopped recording. I won't write anything new about you, and I won't read " +
            "your past memories back into our conversations. What's already on Walrus stays there " +
            "until its storage epochs lapse; I won't pretend otherwise. Say `/remember me` to undo.",
        };
      }
      return {
        handled: true,
        reply:
          "Straight answer: Walrus Memory is append-only, so I can't delete what's already written — " +
          "those blobs live on Walrus until their storage epochs lapse, and any delete button I showed " +
          "you would be lying. What I can do is stop recording and stop reading you back. " +
          "Say `/forgetme confirm` and I'll treat you as a stranger from here on.",
        actions: ["forgetconfirm"],
      };
    }

    case "/remember": {
      if (arg.toLowerCase() === "me") {
        await setOptOut(person.personId, false);
        return { handled: true, reply: "Recording again. Picking up where we left off." };
      }
      return { handled: false };
    }

    default:
      return { handled: false };
  }
}

export { resolvePerson };

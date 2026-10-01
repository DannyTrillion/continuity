/**
 * Surface-agnostic slash commands.
 *
 * Telegram, Discord and the web chat all route text through here first, so
 * linking behaves identically everywhere and lives in one place.
 */

import { issueLinkCode, redeemLinkCode, resolvePerson, setOptOut } from "./identity.mjs";
import { recall, personNs, KB_NS } from "./memory.mjs";
import { searchWeb, screenshotUrl } from "./web.mjs";
import { MODES, isMode, modeFor, setMode, planItems, stackItems, awayInWords } from "./modes.mjs";
import { listMaterials } from "./study.mjs";
import { startQuiz, answerQuiz, LETTERS } from "./quiz.mjs";

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
  modepage:      { label: "See the four modes", url: SITE && `${SITE}/modes`, webApp: true },
};

/* One action per mode, built from the registry so a mode added there becomes
   a button on both bots without either adapter changing. Two of them: the
   plain name for the picker, and a fuller sentence for when the assistant is
   the one offering. */
for (const [id, m] of Object.entries(MODES)) {
  ACTIONS[`mode-${id}`] = { label: m.label, say: `/mode ${id}` };
  ACTIONS[`switch-${id}`] = { label: `Switch to ${m.label}`, say: `/mode ${id}` };
}
ACTIONS["study"] = { label: "What I'm studying", say: "/study" };
ACTIONS["quiz"]  = { label: "Quiz me", say: "/quiz" };
/* The four options under a question. Built rather than written out so a
   quiz with fewer options draws fewer buttons and never a dead one. */
for (const [i, letter] of LETTERS.entries()) {
  ACTIONS[`answer-${i}`] = { label: letter, say: `/answer ${i}` };
}
ACTIONS["plans"] = { label: "What's coming up", say: "/plans" };
ACTIONS["stack"] = { label: "What you know about my setup", say: "/stack" };
ACTIONS["kb"]    = { label: "Search the handbook", say: "/kb" };
/**
 * The buttons that belong to each mode.
 *
 * A mode is a manner, but a manner with nothing to tap is indistinguishable
 * from a setting nobody changed. These are what each one is actually for,
 * offered the moment it is chosen and listed on /modes.
 */
export const MODE_LINKS = {
  tutor:   ["study", "quiz"],
  coding:  ["stack"],
  planner: ["plans"],
  support: ["kb"],
};

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
  ["/study", "The notes and PDFs you've given me to teach you from"],
  ["/quiz", "Test you on them, and remember what you missed"],
  ["/plans", "What you have coming up, and what just went"],
  ["/stack", "What I know about your tools and versions"],
  ["/kb WORDS", "Look something up in the support handbook"],
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
  { name: "study", description: "The notes and PDFs I'm teaching you from" },
  { name: "quiz", description: "Ask me to test you on them" },
  { name: "plans", description: "What you have coming up, and what just passed" },
  { name: "stack", description: "What I know about your setup" },
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
      /* Arriving cold. This is the one message everybody reads and most
         people decide on, so it shows what the bot can do rather than
         describing it — and on Telegram the things worth showing are the
         ones you cannot do anywhere else. Short lines, because this lands
         on a phone. */
      const handle = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
      const tips =
        surface === "telegram"
          ? [
              "• Forward me anything — I'll keep it, and remember who said it",
              "• Send a photo or a file and I'll read it",
              handle && `• Type @${handle} in any chat to pull up what I know, without leaving it`,
            ].filter(Boolean)
          : ["• Send me a photo or a file and I'll read it", "• Ask me what I know about you any time"];

      return {
        handled: true,
        reply:
          "Hey — I'm Continuity. Tell me something once and I'll still know it tomorrow, " +
          "here or on Discord or the web chat.\n\n" +
          `${tips.join("\n")}\n\n` +
          "Or just talk to me normally. Anything worth keeping, I'll keep.",
        actions: ["whatyouknow", "modes", "memory", "link", "help"],
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
          /* The mode's own thing to do, offered the moment it is picked.
             Choosing Tutor and then being shown "What do you know about me?"
             teaches nothing about what Tutor is for. */
          actions: [...(MODE_LINKS[want] ?? []), "whatyouknow", "mode-off"],
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
        /* Four blurbs is not much to choose from, so the page that shows what
           each one actually does sits under them — as a Mini App on Telegram,
           so reading it does not cost you the chat you were in. */
        actions: [...Object.keys(MODES).filter((id) => id !== current).map((id) => `mode-${id}`),
                  ...(current ? ["mode-off"] : []), "modepage"],
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

    /**
     * What they have given the tutor to teach from.
     *
     * Only reachable in Tutor mode, because outside it there is nothing to
     * list and a command that always answers "nothing here" teaches people
     * the feature is broken rather than that they are in the wrong mode.
     */
    case "/study": {
      const mode = await modeFor(person.personId).catch(() => null);
      const materials = await listMaterials(person.personId).catch(() => []);

      if (!materials.length) {
        return {
          handled: true,
          reply:
            mode === "tutor"
              ? "Nothing to study yet. Send me a PDF or your notes and I'll read them, then /quiz will ask you about it."
              : "Study materials live in Tutor mode. Switch to it, send me your notes, and I'll quiz you on them.",
          actions: mode === "tutor" ? ["help"] : ["mode-tutor"],
        };
      }

      return {
        handled: true,
        reply:
          `You've given me ${materials.length} thing${materials.length === 1 ? "" : "s"} to study:\n\n` +
          materials.map((m, i) => `${i + 1}. ${m.name}`).join("\n") +
          `\n\n/quiz and I'll ask you about the newest one.`,
        actions: ["quiz", "memory"],
      };
    }

    /**
     * Ask them about it.
     *
     * Starting a round costs one model call over the material's full text, so
     * the reply is slow enough to be worth saying something about — the
     * adapters keep a typing indicator alive for exactly this.
     */
    case "/quiz": {
      const materials = await listMaterials(person.personId).catch(() => []);
      if (!materials.length) {
        return {
          handled: true,
          reply: "Send me something to quiz you on first — a PDF or your notes, in Tutor mode.",
          actions: ["mode-tutor"],
        };
      }
      const pick = materials[0];
      const started = await startQuiz(person.personId, { file: pick.file, name: pick.name });
      if (!started.ok) return { handled: true, reply: started.error, actions: ["study"] };

      return {
        handled: true,
        reply:
          `**${pick.name}** — question 1 of ${started.total}\n\n${started.question}\n\n` +
          started.options.map((o, i) => `${LETTERS[i]}. ${o}`).join("\n"),
        actions: started.options.map((_, i) => `answer-${i}`),
      };
    }

    /* The reply to a tapped option. Not in any menu: it only ever arrives
       from a button the bot drew a moment ago. */
    case "/answer": {
      const result = answerQuiz(person.personId, Number(arg));
      if (!result.ok) return { handled: true, reply: result.error, actions: ["quiz"] };

      const head = result.right ? "Right." : `Not quite — it's "${result.correct}".`;
      const why = result.why ? `\n${result.why}` : "";

      if (result.done) {
        return {
          handled: true,
          reply:
            `${head}${why}\n\n**${result.score} out of ${result.total}** on ${result.material}.` +
            (result.score < result.total
              ? `\n\nI've kept what you missed — ask me about it any time, on any app.`
              : `\n\nNothing missed.`),
          actions: ["quiz", "study", "memory"],
        };
      }

      const n = result.next;
      return {
        handled: true,
        reply:
          `${head}${why}\n\n— — —\n\nQuestion ${n.number} of ${n.total}\n\n${n.question}\n\n` +
          n.options.map((o, i) => `${LETTERS[i]}. ${o}`).join("\n"),
        actions: n.options.map((_, i) => `answer-${i}`),
      };
    }

    /**
     * Planner's own view: what is coming, and what has just gone.
     *
     * Dates were already being pinned to the calendar on the way into memory,
     * and already being noticed when one passed — this just shows the person
     * the thing the assistant has been quietly tracking, instead of making
     * them ask "what have I got on?" and hope it mentions everything.
     */
    case "/plans": {
      const dated = await planItems(person);
      const soon = dated.filter((d) => d.away >= 0);
      const gone = dated.filter((d) => d.away < 0).slice(-3);

      if (!soon.length && !gone.length) {
        return {
          handled: true,
          reply:
            "Nothing with a date on it yet. Tell me when something is happening — \"my interview is next Tuesday\" — and I'll keep track of it and ask how it went.",
          actions: ["mode-planner"],
        };
      }

      const line = (d) => `• ${d.text.slice(0, 110)} — ${awayInWords(d.away)}`;
      return {
        handled: true,
        reply:
          (soon.length ? `Coming up:\n${soon.slice(0, 6).map(line).join("\n")}` : "Nothing coming up.") +
          (gone.length ? `\n\nJust gone:\n${gone.map(line).join("\n")}` : ""),
        actions: ["whatyouknow", "memory"],
      };
    }

    /**
     * The coding partner's promise, made checkable.
     *
     * "Never ask them to repeat their setup" is a claim the person has no way
     * to verify until it fails. This shows them what it actually has, so a
     * gap is something they can fix in one sentence rather than discover
     * halfway through an answer written for the wrong stack.
     */
    case "/stack": {
      const kept = await stackItems(person);
      return {
        handled: true,
        reply: kept.length
          ? `What I've got on your setup:\n\n${kept.map((t) => `• ${t.text.slice(0, 120)}`).join("\n")}\n\nAnything wrong or missing, just tell me.`
          : "I don't know your setup yet. Tell me once — language, runtime, package manager, editor — and I'll stop asking.",
        actions: kept.length ? ["memory", "mode-coding"] : ["mode-coding"],
      };
    }

    /**
     * What the support desk answers from.
     *
     * The knowledge base is shared and it is the one body of text in here
     * nobody wrote about themselves, so being able to search it directly is
     * the difference between a desk that cites something and one that just
     * sounds confident.
     */
    case "/kb": {
      if (!arg) {
        return {
          handled: true,
          reply: "Give me something to look up — `/kb refund policy`. I'll answer from the handbook rather than from memory.",
          actions: ["mode-support", "help"],
        };
      }
      const hits = await recall(KB_NS, arg, { limit: 4, maxTokens: 700 }).catch(() => []);
      if (!hits.length) {
        return { handled: true, reply: `Nothing in the handbook about "${arg}".`, actions: ["help"] };
      }
      return {
        handled: true,
        reply:
          `From the handbook, on "${arg}":\n\n` +
          hits.map((h) => `• ${String(h.text).replace(/\s+/g, " ").trim().slice(0, 230)}`).join("\n\n"),
        actions: ["mode-support"],
      };
    }

    default:
      return { handled: false };
  }
}

export { resolvePerson };

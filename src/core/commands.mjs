/**
 * Surface-agnostic slash commands.
 *
 * Telegram, Discord and the web chat all route text through here first, so
 * linking behaves identically everywhere and lives in one place.
 */

import { issueLinkCode, redeemLinkCode, resolvePerson, setOptOut } from "./identity.mjs";
import { recall } from "./memory.mjs";
import { searchWeb, screenshotUrl } from "./web.mjs";

const HELP = `I remember you across Discord, Telegram and the web chat.

Just talk to me normally — anything worth keeping, I'll keep. Paste a link and
I'll read it before I answer.

/link — get a code to connect this account to another app
/link CODE — redeem a code from another app
/shot URL — send back a screenshot of a page
/search WORDS — look something up on the web
/whatyouknow — show what I remember about you
/forgetme — stop recording me
/help — this message`;

export async function handleCommand({ text, surface, surfaceUserId, person }) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd.toLowerCase()) {
    case "/help":
      return { handled: true, reply: HELP };

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
        return { handled: true, reply: "Nothing yet — we haven't talked about anything worth keeping." };
      }
      const lines = hits.map((h) => `• ${h.text}`).join("\n");
      return { handled: true, reply: `Here's what I have:\n\n${lines}` };
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

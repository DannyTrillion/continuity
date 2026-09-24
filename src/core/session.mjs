/**
 * The single entry point every surface calls.
 *
 * Identity caching lives in identity.mjs and nowhere else. A second cache here
 * could go stale against it — a freshly linked account served its pre-link
 * person — so there is exactly one source of truth.
 */

import { resolvePerson } from "./identity.mjs";
import { handleCommand } from "./commands.mjs";
import { handleTurn } from "./agent.mjs";

const HISTORY_TURNS = 6;

const histories = new Map(); // personId -> [{role, content}]

const person = (surface, surfaceUserId, displayName) =>
  resolvePerson(surface, surfaceUserId, { displayName });

/** Short-term conversational context. Walrus holds the long term; this is just the last few turns. */
function history(personId) {
  return histories.get(personId) ?? [];
}

function pushHistory(personId, userText, replyText) {
  const h = [...history(personId), { role: "user", content: userText }, { role: "assistant", content: replyText }];
  histories.set(personId, h.slice(-HISTORY_TURNS * 2));
}

/**
 * Handle one inbound message from any surface.
 * Returns `{ reply, meta }`; never throws for ordinary failures.
 */
export async function respond({ surface, surfaceUserId, displayName, text, onDelta, persona, remember = true }) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { reply: "Say something and I'll answer.", meta: {} };

  let who;
  try {
    who = await person(surface, surfaceUserId, displayName);
  } catch (err) {
    // Without this the adapter reports a generic failure, and on a bad day
    // an unreadable identity is how someone becomes a stranger.
    console.error(`[${surface}] could not resolve identity:`, err.message);
    return {
      reply:
        err?.status === 429
          ? "I can't reach my memory right now — too many requests at once. Give it a minute and I'll know you again."
          : "I can't reach my memory right now. Give it a moment and try again.",
      meta: { error: err.message, rateLimited: err?.status === 429 },
    };
  }

  if (trimmed.startsWith("/")) {
    let cmd;
    try {
      cmd = await handleCommand({ text: trimmed, surface, surfaceUserId, person: who });
    } catch (err) {
      // Commands write to Walrus, and Walrus can be slow or briefly unavailable.
      // Failing silently here is the worst outcome: the user sees a typing
      // indicator stop and has no idea whether anything happened.
      console.error(`[${surface}] command "${trimmed.split(" ")[0]}" failed:`, err.message);
      return {
        reply:
          "That didn't go through — the memory layer was unreachable just then. " +
          "Give it a few seconds and try again.",
        meta: { command: true, error: err.message, personId: who.personId },
      };
    }
    if (cmd.handled) {
      // A successful link changes who this account is.
      if (cmd.relink) who = await person(surface, surfaceUserId, displayName);
      return {
        reply: cmd.reply,
        image: cmd.image,           // /shot returns a PNG for the surface to send
        meta: { command: true, personId: who.personId },
      };
    }
  }

  try {
    const turn = await handleTurn({
      personId: who.personId,
      namespaces: who.namespaces,
      message: trimmed,
      history: history(who.personId),
      surface,
      onDelta,
      persona,
      remember,
    });
    pushHistory(who.personId, trimmed, turn.text);
    return { reply: turn.text, meta: { ...turn, personId: who.personId } };
  } catch (err) {
    console.error(`[${surface}] turn failed:`, err.message);

    // Being unable to READ someone's memory is not the same as not knowing
    // them, and the reply has to make that distinction. Answering as though we
    // had never met would be a lie about the one thing this bot is for.
    const rateLimited = err?.status === 429;
    const wait = err?.retryAfterSeconds;
    const network = !err?.status;

    return {
      reply: rateLimited
        ? `I can't reach my memory right now — too many requests at once. ` +
          `I still know who you are, I just can't read it back this second. ` +
          `Try me again in ${wait ? (wait >= 60 ? `${Math.round(wait / 60)} minutes` : `${wait} seconds`) : "a minute"}.`
        : network
          ? "I lost my connection partway through that. Ask me again — I still know who you are."
          : "I couldn't get to my memory just then. Ask me again in a moment — nothing's lost.",
      meta: { error: err.message, personId: who.personId, rateLimited },
    };
  }
}

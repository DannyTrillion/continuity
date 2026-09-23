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
export async function respond({ surface, surfaceUserId, displayName, text, onDelta }) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { reply: "Say something and I'll answer.", meta: {} };

  let who = await person(surface, surfaceUserId, displayName);

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
    });
    pushHistory(who.personId, trimmed, turn.text);
    return { reply: turn.text, meta: { ...turn, personId: who.personId } };
  } catch (err) {
    console.error(`[${surface}] turn failed:`, err.message);
    // Name what went wrong. "Something broke" tells the person nothing and
    // makes a passing network blip look like the bot is unreliable.
    const network = !err?.status;
    const rateLimited = err?.status === 429;
    return {
      reply: rateLimited
        ? "I'm being rate-limited right now. Give it a few seconds and ask me again."
        : network
          ? "I lost my connection partway through that. Ask me again — I still know who you are."
          : "That one didn't go through. Ask me again in a moment.",
      meta: { error: err.message, personId: who.personId },
    };
  }
}

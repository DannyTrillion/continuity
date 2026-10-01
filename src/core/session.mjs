/**
 * The single entry point every surface calls.
 *
 * Identity caching lives in identity.mjs and nowhere else. A second cache here
 * could go stale against it — a freshly linked account served its pre-link
 * person — so there is exactly one source of truth.
 */

import { resolvePerson } from "./identity.mjs";
import { handleCommand, actionsFor } from "./commands.mjs";
import { handleTurn } from "./agent.mjs";
import { record as recordTurn } from "./conversations.mjs";

const HISTORY_TURNS = 6;

const histories = new Map(); // personId -> [{role, content}]

const person = (surface, surfaceUserId, displayName) =>
  resolvePerson(surface, surfaceUserId, { displayName });

/**
 * Reopen a past conversation: put its last few turns back into short-term
 * context so the next message continues it rather than starting over.
 */
export function resume(personId, turns) {
  const flat = [];
  for (const t of turns.slice(-HISTORY_TURNS)) {
    if (t.you) flat.push({ role: "user", content: t.you });
    if (t.bot) flat.push({ role: "assistant", content: t.bot });
  }
  histories.set(personId, flat);
  return flat.length;
}

/** Whether the server still holds recent turns for this person — false after a restart. */
export const hasHistory = (personId) => (histories.get(personId)?.length ?? 0) > 0;

/** Short-term conversational context. Walrus holds the long term; this is just the last few turns. */
function history(personId) {
  return histories.get(personId) ?? [];
}

function pushHistory(personId, userText, replyText, attachment) {
  // What they attached goes into the history with what they said. Without it
  // the very next message — "where do you think that was taken?" — arrived
  // with no picture in sight, and the model asked what picture.
  const said = attachment?.description
    ? `${userText}\n[They attached ${attachment.name ? `"${attachment.name}"` : "a picture"}: ${String(attachment.description).slice(0, 600)}]`
    : userText;
  const h = [...history(personId), { role: "user", content: said }, { role: "assistant", content: replyText }];
  histories.set(personId, h.slice(-HISTORY_TURNS * 2));
}

/**
 * Handle one inbound message from any surface.
 * Returns `{ reply, meta }`; never throws for ordinary failures.
 */
export async function respond({ surface, surfaceUserId, displayName, text, onDelta, onStage, persona, remember = true, attachment }) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { reply: "Say something and I'll answer.", meta: {} };

  // A retry can only be silent if nothing has been shown yet. Once deltas have
  // streamed, a second attempt would append a whole new answer underneath the
  // half of one the person is already reading.
  let streamed = false;
  const tap = onDelta
    ? (chunk) => { streamed = true; return onDelta(chunk); }
    : undefined;

  let who;
  try {
    who = await person(surface, surfaceUserId, displayName);
  } catch (err) {
    /**
     * Identity is unreadable — almost always a rate limit on the relayer.
     *
     * This used to end the turn with an apology and nothing else, which meant
     * a Walrus hiccup took the entire chatbot offline: ask it anything at all
     * during a 429 and the only thing it would say was that it could not reach
     * its memory. Wrong trade. Not knowing who someone is costs us recall; it
     * does not cost us the ability to answer the question in front of us.
     *
     * So the turn still runs, with every Walrus read and write switched off,
     * and the model is told it is working blind so it cannot improvise a
     * memory. Nothing is written, which is what keeps this safe: with no
     * person id to write under, a memory saved here could land on the wrong
     * person once the relayer recovers.
     */
    console.error(`[${surface}] could not resolve identity:`, err.message);
    const rateLimited = err?.status === 429;
    const wait = err?.retryAfterSeconds;

    try {
      if (streamed) throw err; // half an answer is already on screen
      const blind = await handleTurn({
        personId: `transient:${surface}:${surfaceUserId}`,
        namespaces: [],
        message: trimmed,
        history: [],
        surface,
        onDelta: tap,
        persona,
        remember: false,
        attachment,
        memoryless: true,
      });
      const note = rateLimited
        ? `\n\n-# My memory is rate-limited this minute, so I answered that one cold. ` +
          `Nothing's lost — ask me again in ${wait && wait >= 60 ? `${Math.round(wait / 60)} minutes` : `${wait ?? 60} seconds`} and I'll know you again.`
        : `\n\n-# I couldn't reach my memory just then, so I answered that one cold. Nothing's lost.`;
      return { reply: blind.text + note, meta: { ...blind, error: err.message, rateLimited, memoryless: true } };
    } catch (second) {
      // The model is down too. Now there really is nothing to say.
      console.error(`[${surface}] memoryless fallback also failed:`, second.message);
      return {
        reply: rateLimited
          ? "I can't reach my memory right now — too many requests at once. Give it a minute and I'll know you again."
          : "I can't reach my memory right now. Give it a moment and try again.",
        meta: { error: err.message, rateLimited },
      };
    }
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
        // Named, not drawn: each surface turns these into its own buttons,
        // and `data` into its own layout — an embed on Discord, a list here.
        actions: actionsFor(cmd.actions),
        data: cmd.data ?? null,
        meta: { command: true, personId: who.personId },
      };
    }
  }

  try {
    const turn = await handleTurn({
      personId: who.personId,
      namespaces: who.namespaces,
      message: trimmed,
      onStage,
      history: history(who.personId),
      surface,
      onDelta: tap,
      persona,
      remember,
      attachment,
    });
    pushHistory(who.personId, trimmed, turn.text, attachment);
    recordTurn(who.personId, surface, trimmed, turn.text, {
      attached: attachment?.file ? { file: attachment.file, name: attachment.name } : null,
      picture: turn.picture?.file ? { file: turn.picture.file } : null,
    });
    // `image` rides alongside the reply rather than inside meta: every surface
    // reads it from there already, which is how /shot has always worked. An
    // ordinary turn can suggest something too, so actions come out here as
    // well as from a command.
    return {
      reply: turn.text,
      image: turn.image,
      actions: actionsFor(turn.actions),
      meta: { ...turn, personId: who.personId },
    };
  } catch (err) {
    console.error(`[${surface}] turn failed:`, err.message);

    // Being unable to READ someone's memory is not the same as not knowing
    // them, and the reply has to make that distinction. Answering as though we
    // had never met would be a lie about the one thing this bot is for.
    const rateLimited = err?.status === 429;
    const wait = err?.retryAfterSeconds;
    const network = !err?.status;

    // Same reasoning as the identity failure above: recall being unavailable is
    // not a reason to stop answering, only a reason to stop pretending to
    // remember. We know who they are here, so short-term history still applies.
    try {
      if (streamed) throw err;
      const blind = await handleTurn({
        personId: who.personId,
        namespaces: [],
        message: trimmed,
        history: history(who.personId),
        surface,
        onDelta: tap,
        persona,
        // We know who this is, so what they said can still be queued for
        // memory; the outbox lands it once the relayer is back.
        remember,
        attachment,
        memoryless: true,
      });
      // If it could fall back on what it read a few minutes ago, it did not
      // answer cold, and saying so would be its own small untruth.
      const note = blind.stale
        ? `\n\n-# My memory didn't answer just then, so I went on what I read a few minutes ago.`
        : rateLimited
          ? `\n\n-# I know who you are, I just couldn't read your memory back this ` +
            `second — too many requests at once. Try again in ${wait ? (wait >= 60 ? `${Math.round(wait / 60)} minutes` : `${wait} seconds`) : "a minute"} and it'll be there.`
          : network
            ? `\n\n-# I lost my connection to my memory partway through that, so I answered it cold. Nothing's lost.`
            : `\n\n-# I couldn't read my memory back just then, so I answered that one cold. Nothing's lost.`;
      // Still part of the conversation: the next message has to be able to
      // refer back to this one, and the transcript has to include it.
      pushHistory(who.personId, trimmed, blind.text, attachment);
      recordTurn(who.personId, surface, trimmed, blind.text, {
        attached: attachment?.file ? { file: attachment.file, name: attachment.name } : null,
        picture: blind.picture?.file ? { file: blind.picture.file } : null,
      });
      return { reply: blind.text + note, image: blind.image, meta: { ...blind, error: err.message, personId: who.personId, rateLimited, memoryless: true } };
    } catch (second) {
      console.error(`[${surface}] memoryless fallback also failed:`, second.message);
    }

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

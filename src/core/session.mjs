/**
 * The single entry point every surface calls.
 *
 * Identity caching lives in identity.mjs and nowhere else. A second cache here
 * could go stale against it — a freshly linked account served its pre-link
 * person — so there is exactly one source of truth.
 */

import { resolvePerson } from "./identity.mjs";
import { recall, dedupe, withoutSuppressed, suppressionsFor } from "./memory.mjs";
import { handleCommand, actionsFor, siteIntent, needsNoMemory } from "./commands.mjs";
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

/**
 * Forget the thread, not the person.
 *
 * This is the whole of what /clear does to the model's view: the next message
 * arrives with no short-term context, so the assistant stops referring back to
 * what was just said. It does NOT touch Walrus, and the difference matters
 * enough that the command says so out loud. Memories are the point of the
 * product; a conversation is the thing you might reasonably want to walk away
 * from. Conflating them would mean someone clearing a screen before handing
 * over a laptop had silently wiped months of memory, or — worse the other way
 * — thought they had and hadn't.
 *
 * Returns how many messages were dropped, so the reply can be specific rather
 * than claiming to have cleared something that was already empty.
 */
export function endSession(personId) {
  const had = histories.get(personId)?.length ?? 0;
  histories.delete(personId);
  return had;
}

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
export async function respond({ surface, surfaceUserId, displayName, text, onDelta, onStage, persona, remember = true, attachment, quoted }) {
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

    /* Some commands are about this window, not about this person. Clearing a
       chat and opening a section need no identity, so a busy relayer should
       not turn them into an apology from the model. There is nothing
       server-side to clear for someone we could not identify — the thread is
       keyed by a person id we never got — so this does exactly what it says
       and no less. */
    const offline = trimmed.startsWith("/") ? trimmed : siteIntent(trimmed);
    if (offline && needsNoMemory(offline)) {
      const cmd = await handleCommand({
        text: offline, surface, surfaceUserId,
        person: { personId: `transient:${surface}:${surfaceUserId}` },
      }).catch(() => null);
      if (cmd?.handled) {
        return {
          reply: cmd.reply,
          actions: actionsFor(cmd.actions),
          data: cmd.data ?? null,
          client: cmd.client ?? null,
          meta: { command: true, memoryless: true },
        };
      }
    }

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

  /* Asked in words rather than with a slash. `siteIntent` only answers for a
     short imperative it is sure about, so everything else falls through to the
     model exactly as before. */
  const asCommand = trimmed.startsWith("/") ? trimmed : siteIntent(trimmed);

  if (asCommand) {
    let cmd;
    try {
      cmd = await handleCommand({ text: asCommand, surface, surfaceUserId, person: who });
    } catch (err) {
      // Commands write to Walrus, and Walrus can be slow or briefly unavailable.
      // Failing silently here is the worst outcome: the user sees a typing
      // indicator stop and has no idea whether anything happened.
      console.error(`[${surface}] command "${asCommand.split(" ")[0]}" failed:`, err.message);
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
        // Something for the surface itself to DO, as opposed to say: clear the
        // transcript, open a section. Surfaces that cannot act on it ignore it.
        client: cmd.client ?? null,
        meta: { command: true, personId: who.personId },
      };
    }
  }

  try {
    const turn = await handleTurn({
      personId: who.personId,
      namespaces: who.namespaces,
      // Minted microseconds ago by resolvePerson, so nothing can exist under
      // it. The turn uses this to skip reads whose answer is already known.
      isNew: who.isNew === true,
      message: trimmed,
      onStage,
      history: history(who.personId),
      surface,
      onDelta: tap,
      persona,
      remember,
      attachment,
      quoted,
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
      // A file it found and is sending back, the way `image` carries a picture.
      document: turn.document ?? null,
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
      /**
       * The note has to describe the answer the person is actually looking at.
       *
       * Three different things can have happened by this point and only one of
       * them is "answered cold". It fell back on what it read a few minutes
       * ago; or the answer came out of this very conversation, because they
       * told it one message ago; or it genuinely had nothing. Collapsing those
       * into one apology produces the worst sentence this bot can say — a
       * correct answer, immediately followed by a claim it could not answer.
       *
       * That happened. "Which package manager do I use?" → "pnpm. And you'd
       * switch projects before touching npm." → "-# I know who you are, I just
       * couldn't read your memory back this second." Both halves true, read
       * together as either a bug or a lie. It is the same mistake as telling
       * somebody who asked to be forgotten that storage is broken: the state
       * is fine, the sentence describing it is not.
       */
      const fromThisChat = history(who.personId).length > 0;
      const soon = wait ? (wait >= 60 ? `${Math.round(wait / 60)} minutes` : `${wait} seconds`) : "a minute";
      const note = blind.stale
        ? `\n\n-# My memory didn't answer just then, so I went on what I read a few minutes ago.`
        : fromThisChat
          /* Say where the answer came from, not what failed. The person can
             see it was answered; what they cannot see is that it came from the
             last few messages rather than from storage. */
          ? rateLimited
            ? `\n\n-# That came from this conversation — reading my longer memory back is rate-limited for another ${soon}.`
            : `\n\n-# That came from this conversation; I couldn't reach my longer memory just then. Nothing's lost.`
          : rateLimited
            ? `\n\n-# I know who you are, I just couldn't read your memory back this ` +
              `second — too many requests at once. Try again in ${soon} and it'll be there.`
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

/**
 * Search someone's memory, without answering them.
 *
 * Telegram's inline mode lets a person type `@thebot pnpm` inside ANY chat —
 * including ones this bot has never been added to — and pick from what comes
 * back. That is the clearest expression of the whole idea: the memory follows
 * the person rather than living in one app. But it is a different shape of
 * request from a conversation. Nobody is being answered, so there is no model
 * call, no history, and nothing is written. It is a read.
 *
 * It is also the only path here that fires at typing speed. Telegram debounces
 * keystrokes, not enough: one person composing a word can produce several
 * queries, each of which would otherwise be a relayer round trip against a
 * budget of sixty a minute shared with every other surface. So answers are
 * cached per person and query, and a prefix of a query already answered is
 * served from the same entry rather than asking again.
 */
const lookups = new Map(); // `${personId}\n${query}` -> { hits, at }
const LOOKUP_TTL_MS = 60_000;

export async function lookup({ surface, surfaceUserId, query, limit = 8 }) {
  const who = await resolvePerson(surface, String(surfaceUserId));
  const q = String(query ?? "").trim().toLowerCase().slice(0, 120);

  const fresh = (entry) => entry && Date.now() - entry.at < LOOKUP_TTL_MS;
  const key = `${who.personId}\n${q}`;
  if (fresh(lookups.get(key))) return { personId: who.personId, hits: lookups.get(key).hits };

  // Someone typing "pnp" then "pnpm" asks two questions a second apart whose
  // answers are the same. If a longer query that starts with this one was
  // just answered, reuse it rather than spending another read.
  for (const [k, entry] of lookups) {
    if (!fresh(entry)) { lookups.delete(k); continue; }
    const [pid, asked] = k.split("\n");
    if (pid === who.personId && q.length >= 2 && asked.startsWith(q)) {
      return { personId: who.personId, hits: entry.hits };
    }
  }

  /* An empty query is not a failed search — it is someone who has just typed
     the bot's name and is waiting to see what it has. Give them the profile. */
  const question = q || "who this person is: their name, work, setup and preferences";
  const [sets, suppressed] = await Promise.all([
    Promise.all(
      who.namespaces.map((ns) =>
        recall(ns, question, { limit, maxTokens: 600 }).catch(() => []),
      ),
    ),
    suppressionsFor(who.personId).catch(() => new Set()),
  ]);

  const hits = dedupe(withoutSuppressed(sets.flat(), suppressed))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((h) => ({ text: h.text, blobId: h.blob_id ?? null, at: h.created_at ?? null }));

  lookups.set(key, { hits, at: Date.now() });
  return { personId: who.personId, hits };
}

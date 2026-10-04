/**
 * What this bot has said, and where, so it can take it back.
 *
 * `/clear` promises a fresh conversation. On the web that means wiping the
 * transcript, which is easy because the page owns it. On Telegram and Discord
 * the messages belong to the platform, and the only ones a bot may remove are
 * its own — so to remove them it has to have kept their ids.
 *
 * Deliberately in memory and deliberately small. These ids are worthless
 * minutes after they are written: Telegram refuses to delete a bot's own
 * message after 48 hours, and a restart losing them costs a tidier screen and
 * nothing else. Writing them to the volume would be storing a list of
 * everything the bot has ever said to someone in order to one day delete it,
 * which is a worse trade than leaving a few messages on a screen.
 *
 * Both caps matter. Without the per-chat cap one long conversation grows
 * without limit; without the chat cap a busy bot holds a row for every person
 * who ever messaged it. Oldest goes first in both cases.
 */

const CHATS = 500;
const PER_CHAT = 80;

const sent = new Map(); // `${surface}:${chatId}` -> [messageId]

const key = (surface, chatId) => `${surface}:${chatId}`;

/** Remember that we just said something here. */
export function noteSent(surface, chatId, messageId) {
  if (!chatId || !messageId) return;
  const k = key(surface, chatId);
  const ids = sent.get(k) ?? [];
  ids.push(messageId);
  if (ids.length > PER_CHAT) ids.splice(0, ids.length - PER_CHAT);
  // Re-inserting moves this chat to the end of the Map's order, which is what
  // makes the eviction below least-recently-used rather than arbitrary.
  sent.delete(k);
  sent.set(k, ids);
  while (sent.size > CHATS) sent.delete(sent.keys().next().value);
}

/** Everything we have said here, and forget we said it. */
export function takeSent(surface, chatId) {
  const k = key(surface, chatId);
  const ids = sent.get(k) ?? [];
  sent.delete(k);
  return ids;
}

export const sentCount = (surface, chatId) => (sent.get(key(surface, chatId)) ?? []).length;

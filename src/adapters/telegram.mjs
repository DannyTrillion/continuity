/**
 * Telegram surface — long polling.
 *
 * Polling rather than webhooks on purpose: no public URL required, so the bot
 * behaves the same on a laptop and on Railway, and there is no webhook to go
 * stale when the deploy URL changes.
 */

import { respond } from "../core/session.mjs";

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

async function call(token, method, body) {
  const res = await fetch(API(token, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json.result;
}

// Telegram's legacy Markdown uses *bold*, not **bold**, and throws a parse
// error on unbalanced entities rather than degrading. Convert what we can.
const toTelegram = (text) =>
  text.replace(/^#+\s*/gm, "").replace(/\*\*(.+?)\*\*/g, "*$1*");

/**
 * Stream a reply by editing one message as the words arrive.
 *
 * Telegram gives no typing feedback beyond a dot, so a ten-second turn is ten
 * seconds of nothing. Editing a single message turns that into words appearing
 * about two seconds in. Telegram rate-limits edits per chat, so this throttles
 * hard and only sends when the text has actually grown.
 */
function streamer(token, chatId) {
  let messageId = null;
  let sent = "";
  let pending = "";
  let timer = null;
  let closed = false;

  const flush = async () => {
    timer = null;
    if (closed || pending === sent || !pending.trim()) return;
    const text = pending;
    try {
      if (messageId === null) {
        const msg = await call(token, "sendMessage", { chat_id: chatId, text });
        messageId = msg.message_id;
      } else {
        await call(token, "editMessageText", { chat_id: chatId, message_id: messageId, text });
      }
      sent = text;
    } catch {
      // A failed edit is cosmetic; the final send below is what matters.
    }
  };

  return {
    onDelta(chunk) {
      pending += chunk;
      if (!timer) timer = setTimeout(flush, 1100);
    },
    async finish(final) {
      closed = true;
      if (timer) clearTimeout(timer);
      if (messageId === null) return null;
      if (final === sent) return messageId;
      // Markdown only at the end: half-finished entities make Telegram reject
      // the edit, and a rejected edit leaves the reply looking truncated.
      await call(token, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: toTelegram(final), parse_mode: "Markdown",
      }).catch(() =>
        call(token, "editMessageText", { chat_id: chatId, message_id: messageId, text: final }).catch(() => {}),
      );
      return messageId;
    },
  };
}

/** Photos go as multipart, with the caption alongside. */
async function sendPhoto(token, chatId, image, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption.slice(0, 1024));
  form.append("photo", new Blob([image.png], { type: "image/png" }), image.name ?? "shot.png");
  const res = await fetch(API(token, "sendPhoto"), { method: "POST", body: form });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram sendPhoto: ${json.description}`);
  return json.result;
}

/** Send with Markdown, falling back to plain text if Telegram rejects the entities. */
async function send(token, chatId, text) {
  try {
    return await call(token, "sendMessage", {
      chat_id: chatId,
      text: toTelegram(text),
      parse_mode: "Markdown",
    });
  } catch {
    return call(token, "sendMessage", { chat_id: chatId, text });
  }
}

export async function startTelegram({ token }) {
  const me = await call(token, "getMe");
  console.log(`[telegram] connected as @${me.username}`);

  await call(token, "setMyCommands", {
    commands: [
      { command: "link", description: "Connect this chat to Discord or the web chat" },
      { command: "whatyouknow", description: "Show what I remember about you" },
      { command: "forgetme", description: "Stop recording me" },
      { command: "help", description: "What I can do" },
    ],
  });

  let offset = 0;
  let stopped = false;

  (async function loop() {
    while (!stopped) {
      try {
        const updates = await call(token, "getUpdates", { offset, timeout: 30 });
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text) continue;

          // Each update is isolated: one failure must not abort the batch, and
          // it must never leave the user watching a typing indicator die.
          try {
            await call(token, "sendChatAction", { chat_id: msg.chat.id, action: "typing" });

            // Walrus writes can outrun Telegram's ~5s typing indicator, so keep
            // it alive rather than letting the chat look dead mid-answer.
            const keepTyping = setInterval(
              () => call(token, "sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {}),
              4000,
            );

            const stream = streamer(token, msg.chat.id);
            let reply, image;
            try {
              ({ reply, image } = await respond({
                surface: "telegram",
                surfaceUserId: String(msg.from.id),
                displayName: msg.from.username ?? msg.from.first_name,
                text: msg.text,
                onDelta: (chunk) => stream.onDelta(chunk),
              }));
            } finally {
              clearInterval(keepTyping);
            }

            const streamed = await stream.finish(reply);
            if (image) await sendPhoto(token, msg.chat.id, image, streamed ? "" : reply);
            else if (!streamed) await send(token, msg.chat.id, reply);
          } catch (err) {
            console.error(`[telegram] update ${u.update_id} failed:`, err.message);
            await send(token, msg.chat.id, "Something went wrong handling that. Try again in a moment.")
              .catch(() => {});
          }
        }
      } catch (err) {
        // Only getUpdates itself reaches here now, so this really is a poll error.
        console.error("[telegram] poll error:", err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  return { stop: () => { stopped = true; } };
}

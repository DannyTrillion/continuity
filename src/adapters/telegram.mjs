/**
 * Telegram surface — long polling.
 *
 * Polling rather than webhooks on purpose: no public URL required, so the bot
 * behaves the same on a laptop and on Railway, and there is no webhook to go
 * stale when the deploy URL changes.
 */

import { respond } from "../core/session.mjs";
import { storeAttachment } from "../core/images.mjs";
import { ACTIONS, MENU_COMMANDS, GROUP_SAFE } from "../core/commands.mjs";

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const walruscan = (blobId) => `https://walruscan.com/mainnet/blob/${encodeURIComponent(blobId)}`;
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A command's answer, as Telegram draws answers.
 *
 * HTML rather than Markdown, and only here. A memory is whatever a person
 * typed, and an unbalanced `*` or `_` in it makes Telegram reject the entire
 * message rather than render it plainly — which is how a memory list becomes
 * silence. In HTML only three characters need escaping and they always can be.
 *
 * Returns null for ordinary conversation, which keeps the Markdown path it
 * has always had.
 */
export function formatted(data) {
  if (data?.kind === "memories") {
    const n = data.items.length;
    const lines = data.items.map((m) =>
      `• ${esc(m.text)}${m.blobId ? ` <a href="${walruscan(m.blobId)}">blob</a>` : ""}`);
    return {
      text: `<b>What I remember about you</b>\n\n${lines.join("\n")}\n\n` +
        `<i>${n} ${n === 1 ? "memory" : "memories"} — each one a blob you can open.</i>`,
      parse_mode: "HTML",
    };
  }
  if (data?.kind === "mode") {
    const rows = Object.entries(data.modes).map(([id, m]) =>
      `${id === data.current ? "▸" : "·"} <b>${esc(m.label)}</b> — ${esc(m.blurb)}`);
    const lead = data.current
      ? `<b>${esc(data.modes[data.current].label)} mode</b>`
      : "<b>How I work</b>";
    return {
      text: `${lead}\n\n${rows.join("\n")}\n\n` +
        `<i>A mode changes how I answer, never what I know — and it follows you to Discord and the web.</i>`,
      parse_mode: "HTML",
    };
  }

  if (data?.kind === "code") {
    return {
      text: `<b>Your link code</b>\n\n<code>${esc(data.code)}</code>\n\n` +
        `It expires in ${data.expiresInMinutes} minutes. Send <code>/link ${esc(data.code)}</code> ` +
        `on Discord or the web chat and everything either of us knows carries over.`,
      parse_mode: "HTML",
    };
  }
  if (data?.kind === "help") {
    const rows = data.commands.map(([c, what]) => `<code>${esc(c)}</code> — ${esc(what[0].toLowerCase() + what.slice(1))}`);
    return { text: `${esc(data.intro)}\n\n${rows.join("\n")}`, parse_mode: "HTML" };
  }
  return null;
}

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
// "-# …" is Discord's small print; here it becomes an italic line.
const toTelegram = (text) =>
  text.replace(/^-#\s+(.*)$/gm, "_$1_").replace(/^#+\s*/gm, "").replace(/\*\*(.+?)\*\*/g, "*$1*");

/**
 * What to do next, as buttons under the reply.
 *
 * Telegram has no way to suggest a command, so without these the bot is a
 * blank box that happens to accept slashes: everything it can do is invisible
 * until someone reads the help. A button that says what it does is the whole
 * difference between a bot that looks finished and one that does not.
 *
 * Two short labels share a row and a long one gets its own, because Telegram
 * squeezes rather than wraps and three buttons abreast come out unreadable.
 */
export function keyboard(actions) {
  if (!actions?.length) return undefined;
  const rows = [];
  for (const a of actions) {
    const button = a.url ? { text: a.label, url: a.url } : { text: a.label, callback_data: `do:${a.id}` };
    const last = rows[rows.length - 1];
    if (last && last.length === 1 && a.label.length <= 24 && last[0].text.length <= 24) last.push(button);
    else rows.push([button]);
  }
  return { inline_keyboard: rows };
}

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
    async finish(final, actions) {
      closed = true;
      if (timer) clearTimeout(timer);
      if (messageId === null) return null;
      const reply_markup = keyboard(actions);
      if (final === sent) {
        // Nothing new to say — but there may still be buttons to hang on it.
        if (reply_markup) {
          await call(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup }).catch(() => {});
        }
        return messageId;
      }
      // Markdown only at the end: half-finished entities make Telegram reject
      // the edit, and a rejected edit leaves the reply looking truncated.
      await call(token, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: toTelegram(final), parse_mode: "Markdown", reply_markup,
      }).catch(() =>
        call(token, "editMessageText", { chat_id: chatId, message_id: messageId, text: final, reply_markup }).catch(() => {}),
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
async function send(token, chatId, text, actions, laidOut) {
  const reply_markup = keyboard(actions);
  // A laid-out answer first, if there is one. Link previews are off for these:
  // a list of ten memories would otherwise drag a Walruscan card under it.
  if (laidOut) {
    const sent = await call(token, "sendMessage", {
      chat_id: chatId, text: laidOut.text, parse_mode: laidOut.parse_mode,
      reply_markup, link_preview_options: { is_disabled: true },
    }).catch(() => null);
    if (sent) return sent;
  }
  try {
    return await call(token, "sendMessage", {
      chat_id: chatId,
      text: toTelegram(text),
      parse_mode: "Markdown",
      reply_markup,
    });
  } catch {
    return call(token, "sendMessage", { chat_id: chatId, text, reply_markup });
  }
}

/**
 * Pull a photo off Telegram and put it through the same pipeline as a web
 * upload: describe it, keep it, and hand back something the turn can use.
 *
 * Two calls, because Telegram gives you a file id and not a file: getFile
 * turns the id into a path, and the path is fetched from a different host.
 */
async function fetchPhoto(token, photo, caption) {
  const info = await call(token, "getFile", { file_id: photo.file_id });
  const path = info?.file_path;
  if (!path) throw new Error("no file_path");

  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());

  const ext = path.split(".").pop()?.toLowerCase() ?? "jpg";
  return storeAttachment({
    bytes,
    name: `telegram-photo.${ext}`,
    type: ext === "png" ? "image/png" : "image/jpeg",
    hint: caption || undefined,
  });
}

export async function startTelegram({ token }) {
  const me = await call(token, "getMe");
  console.log(`[telegram] connected as @${me.username}`);

  /* Built from the one list in core/commands.mjs rather than kept here: two
     hand-maintained menus is how /mode ended up in neither of them. */
  const asTelegram = (c) => ({ command: c.name, description: c.description });
  const PRIVATE_COMMANDS = MENU_COMMANDS.map(asTelegram);
  const GROUP_COMMANDS = MENU_COMMANDS.filter((c) => GROUP_SAFE.has(c.name)).map(asTelegram);

  /* What it says before anyone has said anything to it. Telegram puts the
     description on the empty chat screen — the one moment the bot gets to
     explain itself unprompted — and the short one on its profile card. */
  const setup = [
    ["setMyCommands", { commands: PRIVATE_COMMANDS, scope: { type: "all_private_chats" } }],
    ["setMyCommands", { commands: GROUP_COMMANDS, scope: { type: "all_group_chats" } }],
    ["setMyCommands", { commands: PRIVATE_COMMANDS }],
    ["setMyDescription", {
      description:
        "I remember the people I talk to — here, on Discord, and on the web chat. " +
        "Tell me something once and I'll still know it tomorrow, on whichever one you open.\n\n" +
        "Everything I keep is a blob on Walrus mainnet that your account owns. You can read " +
        "it back with /whatyouknow, and tell me when I've got something wrong.\n\n" +
        "Send me a photo and I'll remember it too. Ask for it later and it comes back.",
    }],
    ["setMyShortDescription", {
      short_description: "One memory, across Telegram, Discord and the web — stored on Walrus mainnet.",
    }],
    ["setChatMenuButton", { menu_button: { type: "commands" } }],
  ];
  for (const [method, body] of setup) {
    await call(token, method, body).catch((err) => console.warn(`[telegram] ${method}:`, err.message));
  }

  /**
   * One inbound thing, answered — whether it was typed or tapped.
   *
   * A tapped button runs the command it stands for through exactly the same
   * path as typing it would: same memory, same writes, same streaming. The
   * button is a shortcut for the person, never a shortcut in the code.
   */
  async function turn({ chatId, from, text, attachment = null }) {
    await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    // Walrus writes can outrun Telegram's ~5s typing indicator, so keep it
    // alive rather than letting the chat look dead mid-answer.
    const keepTyping = setInterval(
      () => call(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),
      4000,
    );
    const stream = streamer(token, chatId);
    let reply, image, actions, data;
    try {
      ({ reply, image, actions, data } = await respond({
        surface: "telegram",
        surfaceUserId: String(from.id),
        displayName: from.username ?? from.first_name,
        text,
        attachment,
        onDelta: (chunk) => stream.onDelta(chunk),
      }));
    } finally {
      clearInterval(keepTyping);
    }
    const streamed = await stream.finish(reply, actions);
    if (image) await sendPhoto(token, chatId, image, streamed ? "" : reply);
    else if (!streamed) await send(token, chatId, reply, actions, formatted(data));
  }

  let offset = 0;
  let stopped = false;

  (async function loop() {
    while (!stopped) {
      try {
        const updates = await call(token, "getUpdates", {
          offset, timeout: 30, allowed_updates: ["message", "callback_query"],
        });
        for (const u of updates) {
          offset = u.update_id + 1;

          /* A tapped button. The tap has to be acknowledged within a few
             seconds or Telegram leaves it spinning; the answer itself may
             take as long as any other turn, which is why the acknowledgement
             goes first and the work goes after. */
          const tap = u.callback_query;
          if (tap) {
            await call(token, "answerCallbackQuery", { callback_query_id: tap.id }).catch(() => {});
            const say = ACTIONS[String(tap.data ?? "").replace(/^do:/, "")]?.say;
            const chatId = tap.message?.chat?.id;
            if (!say || !chatId) continue;
            try {
              await turn({ chatId, from: tap.from, text: say });
            } catch (err) {
              console.error(`[telegram] button ${tap.data} failed:`, err.message);
              await send(token, chatId, "Something went wrong there. Try again in a moment.").catch(() => {});
            }
            continue;
          }

          const msg = u.message;
          // A photo arrives with no `text` at all — its words, if any, are the
          // caption. Skipping anything without `text` meant every picture sent
          // to this bot was silently discarded.
          const text = msg?.text ?? msg?.caption ?? "";
          const hasPhoto = Array.isArray(msg?.photo) && msg.photo.length > 0;
          if (!msg || (!text && !hasPhoto)) continue;

          // Each update is isolated: one failure must not abort the batch, and
          // it must never leave the user watching a typing indicator die.
          try {
            // Telegram sends several sizes of the same photo, smallest first.
            // The largest is the one worth describing and worth keeping.
            // Typing starts before the look, which takes seconds of its own.
            let attachment = null;
            if (hasPhoto) {
              await call(token, "sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {});
              attachment = await fetchPhoto(token, msg.photo[msg.photo.length - 1], text)
                .catch((err) => { console.error("[telegram] could not read photo:", err.message); return null; });
            }

            await turn({
              chatId: msg.chat.id,
              from: msg.from,
              text: text || "What do you make of this?",
              attachment,
            });
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

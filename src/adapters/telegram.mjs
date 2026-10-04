/**
 * Telegram surface — long polling.
 *
 * Polling rather than webhooks on purpose: no public URL required, so the bot
 * behaves the same on a laptop and on Railway, and there is no webhook to go
 * stale when the deploy URL changes.
 */

import { noteSent, takeSent } from "../core/sent.mjs";
import { openSignIn, answerSignIn, denySignIn } from "../core/signin.mjs";
import { resolvePerson, rememberWho } from "../core/identity.mjs";
import { respond, lookup } from "../core/session.mjs";
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
export function keyboard(actions, { private: isPrivate = true } = {}) {
  if (!actions?.length) return undefined;
  const rows = [];
  for (const a of actions) {
    /* A Mini App opens the page inside Telegram, in the reader's own theme,
       instead of throwing them into a browser and losing the thread. Telegram
       only allows it in private chats, and only over HTTPS, so a group or a
       local http:// URL falls back to the ordinary link. */
    const asMiniApp = a.webApp && isPrivate && /^https:\/\//.test(a.url ?? "");
    const button = asMiniApp
      ? { text: a.label, web_app: { url: a.url } }
      : a.url
        ? { text: a.label, url: a.url }
        : { text: a.label, callback_data: `do:${a.id}` };
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
        // Most replies arrive through this path, so without this /clear would
        // sweep away the few that didn't stream and leave the rest on screen.
        noteSent("telegram", chatId, messageId);
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
/**
 * Send a file back as a file.
 *
 * `sendDocument`, not `sendPhoto`: Telegram compresses a photo and strips what
 * it does not need, which is right for a snapshot and destroys a PDF. This is
 * the half that was missing when the bot told somebody it could not fetch the
 * PDF they had sent it, while holding a copy on disk and a blob id on Walrus.
 */
async function sendDocument(token, chatId, doc, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption.slice(0, 1024));
  form.append("document", new Blob([doc.bytes]), doc.name ?? "file");
  const res = await fetch(API(token, "sendDocument"), { method: "POST", body: form });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram sendDocument: ${json.description}`);
  return json.result;
}

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
 * Take back what this bot has said here.
 *
 * Best effort by design: Telegram refuses to delete a bot's own message after
 * 48 hours and refuses outright to touch one the person wrote, so some of the
 * conversation stays on screen whatever happens. The reply to `/clear` says
 * that rather than claiming a clean sweep, and each failure here is ignored
 * instead of surfaced — a message that would not delete is not an error worth
 * interrupting someone's clear with.
 */
async function wipe(token, chatId) {
  const ids = takeSent("telegram", chatId);
  let gone = 0;
  for (const id of ids.reverse()) {
    const ok = await call(token, "deleteMessage", { chat_id: chatId, message_id: id })
      .then(() => true).catch(() => false);
    if (ok) gone += 1;
  }
  return gone;
}

/**
 * Pull a file off Telegram and put it through the same pipeline as a web
 * upload: look at it or read it, keep it, and hand back something the turn
 * can use. `storeAttachment` decides which of those a file gets.
 *
 * Two calls, because Telegram gives you a file id and not a file: getFile
 * turns the id into a path, and the path is fetched from a different host.
 */
async function fetchFile(token, fileId, { name, type, hint }) {
  const info = await call(token, "getFile", { file_id: fileId });
  const path = info?.file_path;
  if (!path) throw new Error("no file_path");

  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());

  const ext = (name?.split(".").pop() ?? path.split(".").pop() ?? "").toLowerCase();
  return storeAttachment({ bytes, name: name ?? `telegram-file.${ext || "bin"}`, type, hint: hint || undefined });
}

const fetchPhoto = (token, photo, caption) => {
  const ext = "jpg";
  return fetchFile(token, photo.file_id, {
    name: `telegram-photo.${ext}`,
    type: "image/jpeg",
    hint: caption,
  });
};

/* getFile tops out around 20MB, and the failure is a flat API error rather
   than anything a person could act on. Checked up front so the refusal can
   say what happened. */
const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;

/**
 * One memory, as a pickable inline result.
 *
 * The title is what someone scans in a dropdown over somebody else's chat, so
 * it gets the first line and nothing else; the rest goes to the description,
 * which Telegram renders smaller and greys out. Picking a result sends the
 * memory's own words, because the point is to drop what you know into the
 * conversation you are already having — not a note about having known it.
 */
export function inlineResult(hit, i) {
  const text = String(hit.text ?? "").replace(/\s+/g, " ").trim();
  const cut = text.length > 64 ? text.slice(0, 63).replace(/\s\S*$/, "") + "…" : text;
  const when = hit.at ? new Date(hit.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : null;
  return {
    type: "article",
    // Unique per result and short: Telegram caps this at 64 bytes and drops
    // the whole answer if two results collide.
    id: String(hit.blobId ?? `m${i}`).slice(0, 64),
    title: cut || "a memory",
    description: [text.length > cut.length ? text.slice(cut.length - 1).trim() : "", when]
      .filter(Boolean).join(" · ").slice(0, 120) || "stored on Walrus",
    input_message_content: { message_text: text },
  };
}

/**
 * Who said the thing that was forwarded here, and when.
 *
 * Forwarding is the most Telegram-native way there is to say "keep this", and
 * the content alone loses the half that matters: a line from a group chat is
 * worth little without knowing who said it. Bot API 7 moved this to
 * `forward_origin`; the older fields are still read because a message can
 * arrive either way depending on the client.
 *
 * Returns null for anything not forwarded, which is the common case.
 */
/**
 * The message this one is answering, if it is answering one.
 *
 * Telegram lets someone reply to any message, not just the latest, and without
 * reading it the bot gets "what did you mean by that?" with no idea which
 * "that". `mine` matters: its own words can be handed back plainly, while
 * anyone else's are quoted material that must not be able to give it orders.
 */
export function replyNote(msg, botId) {
  const r = msg?.reply_to_message;
  const text = r?.text ?? r?.caption ?? null;
  if (!text) return null;
  const mine = Boolean(botId && r.from?.id === botId) || Boolean(r.from?.is_bot && !msg.from?.is_bot && r.from?.id === botId);
  return {
    text,
    who: mine ? null : (r.from?.first_name ?? r.from?.username ?? null),
    mine,
  };
}

export function forwardNote(msg) {
  const o = msg?.forward_origin;
  const when = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null);

  let who = null;
  let at = null;
  if (o) {
    at = when(o.date);
    if (o.type === "user") who = o.sender_user?.first_name ?? o.sender_user?.username ?? null;
    else if (o.type === "hidden_user") who = o.sender_user_name ?? null;
    else if (o.type === "chat") who = o.sender_chat?.title ?? null;
    else if (o.type === "channel") who = o.chat?.title ?? null;
  } else if (msg?.forward_from || msg?.forward_from_chat || msg?.forward_sender_name) {
    at = when(msg.forward_date);
    who =
      msg.forward_from?.first_name ??
      msg.forward_from?.username ??
      msg.forward_from_chat?.title ??
      msg.forward_sender_name ??
      null;
  } else {
    return null;
  }

  // A forward whose origin is hidden is still a forward, and saying so is
  // better than passing it off as something the person said themselves.
  return { who: who ?? "someone", at };
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
        "Forward me anything worth keeping and I'll note who said it and when. " +
        "Send a photo or a file and I'll read it, then bring it back when you ask.\n\n" +
        "Everything I keep is a blob on Walrus mainnet that your account owns. Read it " +
        "back with /whatyouknow, and tell me when I've got something wrong.",
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
  async function turn({ chatId, from, text, attachment = null, quoted = null }) {
    await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    // Walrus writes can outrun Telegram's ~5s typing indicator, so keep it
    // alive rather than letting the chat look dead mid-answer.
    const keepTyping = setInterval(
      () => call(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),
      4000,
    );
    const stream = streamer(token, chatId);
    let reply, image, document, actions, data, client;
    try {
      ({ reply, image, document, actions, data, client } = await respond({
        surface: "telegram",
        surfaceUserId: String(from.id),
        displayName: from.username ?? from.first_name,
        text,
        attachment,
        quoted,
        onDelta: (chunk) => stream.onDelta(chunk),
      }));
    } finally {
      clearInterval(keepTyping);
    }
    /* A command can ask the surface to do something, not only say something.
       The only one so far is /clear, and it runs BEFORE the reply is sent so
       the reply is not the first thing swept away by it. */
    if (client?.do === "clear") await wipe(token, chatId).catch(() => {});

    const streamed = await stream.finish(reply, actions);
    if (document) {
      // The words first if they have not streamed, then the file under them.
      const sent = await sendDocument(token, chatId, document, streamed ? "" : reply)
        .catch((err) => { console.error("[telegram] could not send the file:", err.message); return null; });
      noteSent("telegram", chatId, sent?.message_id);
      if (!sent && !streamed) {
        const fb = await send(token, chatId, reply, actions, formatted(data));
        noteSent("telegram", chatId, fb?.message_id);
      }
    } else if (image) {
      const sent = await sendPhoto(token, chatId, image, streamed ? "" : reply);
      noteSent("telegram", chatId, sent?.message_id);
    } else if (!streamed) {
      const sent = await send(token, chatId, reply, actions, formatted(data));
      noteSent("telegram", chatId, sent?.message_id);
    }
  }

  let offset = 0;
  let stopped = false;

  (async function loop() {
    while (!stopped) {
      try {
        const updates = await call(token, "getUpdates", {
          offset, timeout: 30, allowed_updates: ["message", "callback_query", "inline_query"],
        });
        for (const u of updates) {
          offset = u.update_id + 1;

          /* Someone typing `@thebot pnpm` in a chat this bot has never been
             added to. Nobody is being answered: they are searching their own
             memory from inside someone else's conversation, which is the
             clearest form the idea takes — the memory goes where the person
             goes, not where the bot was installed.
             `is_personal` matters here. These results are one person's
             memories, and Telegram would otherwise cache them against the
             query alone and serve them to the next person who typed it. */
          const inline = u.inline_query;
          if (inline) {
            try {
              const { hits } = await lookup({
                surface: "telegram",
                surfaceUserId: String(inline.from.id),
                query: inline.query,
              });
              await call(token, "answerInlineQuery", {
                inline_query_id: inline.id,
                is_personal: true,
                cache_time: 10,
                results: hits.map((h, i) => inlineResult(h, i)),
                ...(hits.length ? {} : {
                  button: {
                    text: inline.query.trim()
                      ? `Nothing about "${inline.query.trim().slice(0, 30)}" yet — open the chat`
                      : "Nothing stored yet — say hello first",
                    start_parameter: "inline",
                  },
                }),
              });
            } catch (err) {
              console.error("[telegram] inline query failed:", err.message);
              // An unanswered inline query just spins. Saying so beats that.
              await call(token, "answerInlineQuery", {
                inline_query_id: inline.id, is_personal: true, cache_time: 0, results: [],
                button: { text: "Couldn't reach my memory — tap to open the chat", start_parameter: "inline" },
              }).catch(() => {});
            }
            continue;
          }

          /* A tapped button. The tap has to be acknowledged within a few
             seconds or Telegram leaves it spinning; the answer itself may
             take as long as any other turn, which is why the acknowledgement
             goes first and the work goes after. */
          const tap = u.callback_query;
          if (tap) {
            await call(token, "answerCallbackQuery", { callback_query_id: tap.id }).catch(() => {});

            /* A sign-in answer. One attempt: a wrong number ends the request
               rather than offering another go, which is what stops three taps
               beating three options. */
            const pick = /^si:([0-9a-f]+):(\d+|no)$/i.exec(String(tap.data ?? ""));
            if (pick) {
              const chatId = tap.message?.chat?.id;
              const [, id, choice] = pick;
              let text;
              if (choice === "no") {
                denySignIn(id);
                text = "Stopped. Nothing was signed in.\n\nIf that wasn't you at all, nobody got access — they only ever saw a number.";
              } else {
                const me = await resolvePerson("telegram", String(tap.from.id), {
                  displayName: tap.from.username ?? tap.from.first_name,
                }).catch(() => null);
                const out = answerSignIn(id, choice, {
                  personId: me?.personId,
                  surfaceUserId: String(tap.from.id),
                });
                /* The browser has just inherited this person. Whatever
                   Telegram already knows about them goes in with it, so the
                   web does not greet somebody who has just proved who they
                   are by asking what to call them. */
                if (out.ok && me?.personId) {
                  rememberWho(me.personId, {
                    firstName: tap.from.first_name,
                    handle: tap.from.username ?? null,
                    surface: "Telegram",
                  });
                }
                text = out.ok
                  ? "✅ *Confirmed.* Go back to your browser — it signs you in, and everything I know about you comes with it."
                  : out.reason === "wrong"
                    ? "That's not the number on the website, so I've stopped this sign-in. If it wasn't you who started it, nothing has happened."
                    : "That sign-in is no longer open. Start a new one on the website.";
              }
              if (chatId) {
                const sent = await call(token, "sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" })
                  .catch(() => null);
                noteSent("telegram", chatId, sent?.message_id);
              }
              continue;
            }

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

          /* Signing in to the website. The deep link carries the request id,
             so this arrives as "/start si<id>" and is answered here rather
             than going through the model: there is nothing to say yet, only a
             number to confirm. */
          const si = /^\/start\s+si([0-9a-f]{16,})$/i.exec(msg?.text ?? "");
          if (si) {
            const chatId = msg.chat.id;
            const who = String(msg.from.id);
            const opened = openSignIn(si[1], who);
            if (!opened.ok) {
              const why = {
                expired: "That sign-in link has expired. Start again on the website and I'll ask you straight away.",
                approved: "That one's already done. Go back to your browser.",
                denied: "That sign-in was turned down, so nothing happened.",
                wrong: "That sign-in was answered with the wrong number, so I stopped it. Start a new one on the website.",
                "too-many": "That's a lot of sign-in requests in one hour. I've stopped sending them for a bit. If these weren't you, nothing has been approved.",
              }[opened.reason] ?? "I can't sign that one in.";
              const sent = await send(token, chatId, why);
              noteSent("telegram", chatId, sent?.message_id);
              continue;
            }
            const sent = await call(token, "sendMessage", {
              chat_id: chatId,
              text:
                `🔐 *Sign in to Continuity in a web browser?*\n` +
                `Browser: ${opened.device}\n\n` +
                `Tap the number you see on the website.\n` +
                `Didn't ask for this? Tap *Not me* — nothing happens.`,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  opened.digits.map((d) => ({ text: String(d), callback_data: `si:${si[1]}:${d}` })),
                  [{ text: "Not me", callback_data: `si:${si[1]}:no` }],
                ],
              },
            }).catch(() => null);
            noteSent("telegram", chatId, sent?.message_id);
            continue;
          }
          // A photo arrives with no `text` at all — its words, if any, are the
          // caption. Skipping anything without `text` meant every picture sent
          // to this bot was silently discarded.
          const text = msg?.text ?? msg?.caption ?? "";
          const hasPhoto = Array.isArray(msg?.photo) && msg.photo.length > 0;
          const doc = msg?.document ?? null;
          if (!msg || (!text && !hasPhoto && !doc)) continue;

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
            } else if (doc) {
              if ((doc.file_size ?? 0) > TELEGRAM_FILE_LIMIT) {
                await send(token, msg.chat.id, "That file is over 20MB, which is more than Telegram will hand me. Send a smaller one and I'll read it.");
                continue;
              }
              await call(token, "sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {});
              attachment = await fetchFile(token, doc.file_id, {
                name: doc.file_name, type: doc.mime_type, hint: text,
              }).catch((err) => { console.error("[telegram] could not read document:", err.message); return null; });
            }

            /* Forwarding something into the bot is Telegram's own gesture for
               "keep this", so it is treated as one: the origin is carried into
               the turn, because a line from a group chat is worth little
               without knowing who said it. */
            const fwd = forwardNote(msg);
            const body = text || (attachment ? "What do you make of this?" : "");
            const said = fwd
              ? `I'm forwarding you something ${fwd.who} said${fwd.at ? ` on ${fwd.at}` : ""}. ` +
                `Keep it, and say briefly what you've kept.\n\n"""\n${body}\n"""`
              : body;

            await turn({
              chatId: msg.chat.id,
              from: msg.from,
              text: said || "What do you make of this?",
              attachment,
              quoted: replyNote(msg, me.id),
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

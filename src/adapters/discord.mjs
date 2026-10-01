/**
 * Discord surface.
 *
 * Discord reserves "/" for application commands, so the text commands the other
 * surfaces use cannot work here: typing `/link ABC123` in Discord opens the
 * command picker, matches nothing, and the message is usually never sent. On
 * top of that the bot ignores channel messages that do not mention it, so even
 * when the text did send it was discarded. Linking appeared to do nothing.
 *
 * So Discord gets real registered commands, plus ordinary conversation by DM or
 * mention. Commands are registered per guild as well as globally: global
 * registration can take up to an hour to appear, which looks broken to someone
 * who just added the bot.
 */

import {
  Client, GatewayIntentBits, Partials, Events, MessageFlags, ActivityType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ApplicationCommandType,
} from "discord.js";
import { readFile } from "node:fs/promises";
import { respond } from "../core/session.mjs";
import { storeAttachment } from "../core/images.mjs";
import { canRead } from "../core/documents.mjs";
import { ACTIONS, MENU_COMMANDS } from "../core/commands.mjs";
import { MODES } from "../core/modes.mjs";

const DISCORD_LIMIT = 2000;
const BRAND = 0x5aa9ff;                       // the blue everything else uses
const EMBED_BODY_LIMIT = 4000;                // Discord allows 4096; leave room
const AVATAR = new URL("../web/assets/avatar.png", import.meta.url);
const walruscan = (blobId) => `https://walruscan.com/mainnet/blob/${encodeURIComponent(blobId)}`;

/**
 * A command's answer, as Discord draws answers.
 *
 * Plain text is right for conversation — it streams, and a wall of chat is
 * what a chat should look like. A command's answer is not conversation: it is
 * a list, or a code, or a table, and Discord has a way of showing those that
 * makes a bot look like software rather than like someone typing. So the
 * structured half of what `handleCommand` returns becomes an embed, and the
 * conversational half stays as it was.
 *
 * Memories carry a link to the blob that holds them. That is the whole claim
 * of this project, one tap from a Discord message.
 */
export function embedFor(data) {
  if (!data) return null;

  if (data.kind === "help") {
    return {
      color: BRAND,
      title: "What I can do",
      description: data.intro,
      fields: data.commands.map(([name, what]) => ({ name, value: what, inline: true })),
      footer: { text: "Memories are stored on Walrus mainnet" },
    };
  }

  if (data.kind === "memories") {
    const lines = [];
    let room = EMBED_BODY_LIMIT;
    for (const m of data.items) {
      const line = `• ${m.text}${m.blobId ? ` — [blob](${walruscan(m.blobId)})` : ""}`;
      if (line.length + 1 > room) break;
      room -= line.length + 1;
      lines.push(line);
    }
    const hidden = data.items.length - lines.length;
    return {
      color: BRAND,
      title: `What I remember about you`,
      description: lines.join("\n") + (hidden > 0 ? `\n\n…and ${hidden} more.` : ""),
      footer: {
        text: `${data.items.length} ${data.items.length === 1 ? "memory" : "memories"} · each one a blob you can open`,
      },
    };
  }

  if (data.kind === "mode") {
    return {
      color: BRAND,
      title: data.current ? `${data.modes[data.current].label} mode` : "How I work",
      description: data.current
        ? `${data.modes[data.current].blurb}. Same memory either way — only the manner changes, ` +
          `and it follows you to Telegram and the web.`
        : "Pick one and I'll work that way on every app. What I remember is the same whichever you choose.",
      fields: Object.entries(data.modes).map(([id, m]) => ({
        name: id === data.current ? `${m.label}  ← you` : m.label,
        value: m.blurb,
        inline: true,
      })),
      footer: { text: "A mode changes how I answer, never what I know" },
    };
  }

  if (data.kind === "code") {
    return {
      color: BRAND,
      title: "Your link code",
      description: `\`\`\`\n${data.code}\n\`\`\``,
      fields: [
        { name: "Expires in", value: `${data.expiresInMinutes} minutes`, inline: true },
        { name: "Where to use it", value: "Send `/link CODE` on Telegram or the web chat", inline: true },
      ],
      footer: { text: "Everything either account has told me carries over, both ways" },
    };
  }
  return null;
}

/** An embed replaces the text it was built from; anything else keeps its text. */
const bodyFor = (reply, data, components) => {
  const embed = embedFor(data);
  return embed ? { content: "", embeds: [embed], components } : { content: chunk(reply)[0], components };
};

export const COMMANDS = [
  /**
   * Right-click any message → Apps → Remember this.
   *
   * Discord's own gesture for "keep this", and the counterpart to forwarding
   * a message into the bot on Telegram. It is the only way to hand the
   * assistant something somebody else said without retyping it, and the
   * attribution — who wrote it, in which channel — is the half that makes it
   * worth keeping at all.
   *
   * A context-menu command takes no options and its name is shown verbatim,
   * so it is capitalised like a menu item rather than a slash command.
   */
  { name: "Remember this", type: ApplicationCommandType.Message },
  { name: "study", description: "The notes and PDFs I'm teaching you from" },
  { name: "plans", description: "What you have coming up, and what just passed" },
  { name: "stack", description: "What I know about your setup" },
  {
    name: "kb",
    description: "Look something up in the support handbook",
    options: [
      { name: "query", description: "What to look up", type: 3, required: true },
    ],
  },
  { name: "quiz", description: "Test you on them, and remember what you missed" },
  {
    name: "link",
    description: "Connect this Discord account to the web chat or Telegram",
    options: [
      {
        name: "code",
        description: "The six-character code from the other app (leave empty to get one)",
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: "shot",
    description: "Screenshot a web page",
    options: [{ name: "url", description: "The page to capture", type: 3, required: true }],
  },
  {
    name: "search",
    description: "Look something up on the web",
    options: [{ name: "query", description: "What to look for", type: 3, required: true }],
  },
  {
    name: "mode",
    description: "How I work: tutor, coding partner, planner, support",
    options: [{
      name: "which",
      description: "Pick one, or leave it empty to see them all",
      type: 3, // STRING
      required: false,
      // Discord turns choices into a picker, so the modes are a dropdown
      // rather than something to spell correctly.
      choices: [
        ...Object.entries(MODES).map(([value, m]) => ({ name: m.label, value })),
        { name: "No mode", value: "off" },
      ],
    }],
  },
  { name: "remember", description: "Show everything I remember about you" },
  { name: "menu", description: "The things I do most, as buttons" },
  { name: "forget", description: "Stop remembering me" },
  { name: "help", description: "What I can do" },
];

/**
 * What to do next, as a row of buttons.
 *
 * The actions themselves are named in core/commands.mjs so Telegram and
 * Discord offer the same things; only the drawing differs. Discord takes five
 * to a row, and an action that carries a URL becomes a link button — which is
 * how someone gets from a DM to their memory page without copying anything.
 */
export function rowsFor(actions) {
  if (!actions?.length) return [];
  const buttons = actions.slice(0, 5).map((a) =>
    a.url
      ? new ButtonBuilder().setLabel(a.label).setStyle(ButtonStyle.Link).setURL(a.url)
      : new ButtonBuilder()
          .setCustomId(`do:${a.id}`)
          .setLabel(a.label)
          .setStyle(a.danger ? ButtonStyle.Danger : ButtonStyle.Secondary),
  );
  return [new ActionRowBuilder().addComponents(...buttons)];
}

/**
 * Edit one reply as the words arrive, rather than leaving a deferred
 * interaction blank for the length of the turn. Discord's edit rate limits are
 * unforgiving, so this is throttled and only fires when the text has grown.
 */
function streamer(edit) {
  let sent = "";
  let pending = "";
  let timer = null;
  let closed = false;

  const flush = async () => {
    timer = null;
    if (closed || pending === sent || !pending.trim()) return;
    const text = pending.slice(0, DISCORD_LIMIT);
    try {
      await edit(text);
      sent = text;
    } catch { /* cosmetic; the final edit is what counts */ }
  };

  return {
    onDelta(chunk) {
      pending += chunk;
      if (!timer) timer = setTimeout(flush, 1300);
    },
    async finish(final) {
      closed = true;
      if (timer) clearTimeout(timer);
      return sent !== "";
    },
  };
}

/** Discord hard-caps messages at 2000 chars; split on paragraphs, not mid-word. */
function chunk(text) {
  if (text.length <= DISCORD_LIMIT) return [text];
  const out = [];
  let buf = "";
  for (const para of text.split("\n\n")) {
    if ((buf + "\n\n" + para).length > DISCORD_LIMIT) {
      if (buf) out.push(buf);
      buf = para.slice(0, DISCORD_LIMIT);
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Discord hosts the file and hands us a URL; fetch it and treat it like any other. */
/* Discord will hand a bot files up to 25MB on a free server, and more on a
   boosted one. Checked before the download rather than after, so a refusal
   costs nothing and can say what happened. */
const DISCORD_FILE_LIMIT = 25 * 1024 * 1024;

/**
 * Pull an attachment off Discord and put it through the same pipeline as a web
 * upload — `storeAttachment` decides whether it gets looked at or read.
 *
 * This used to take only pictures, so the assistant could read your notes on
 * the web and on Telegram but not here. Same product, same person, same
 * memory: the asymmetry was the bug.
 */
async function fetchAttachment(att, said) {
  if ((att.size ?? 0) > DISCORD_FILE_LIMIT) throw new Error("over Discord's file limit");
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return storeAttachment({
    bytes,
    name: att.name ?? "discord-file",
    type: att.contentType ?? undefined,
    hint: said || undefined,
  });
}

/* Anything the shared pipeline can do something with: a picture to look at,
   or a document to read. Everything else is left alone rather than stored as
   a sentence describing a file nobody can open. */
const USABLE = (a) =>
  /^image\/(png|jpe?g|gif|webp)$/i.test(a.contentType ?? "") ||
  canRead(a.contentType, String(a.name ?? "").split(".").pop());

export async function startDiscord({ token }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // required to receive DMs
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] connected as ${c.user.tag}`);

    /* The face and the status line. The avatar is set only when the bot has
       none, because Discord rate-limits avatar changes hard and a restart
       loop that re-uploaded every time would lock the bot out of its own
       profile. Pass DISCORD_SET_AVATAR=1 to replace one deliberately. */
    try {
      if (!c.user.avatar || process.env.DISCORD_SET_AVATAR === "1") {
        await c.user.setAvatar(await readFile(AVATAR));
        console.log("[discord] avatar set");
      }
      c.user.setPresence({
        status: "online",
        activities: [{ type: ActivityType.Listening, name: "everything you tell me" }],
      });
    } catch (err) {
      console.warn("[discord] could not set the profile:", err.message);
    }

    try {
      await c.application.commands.set(COMMANDS);
      for (const [, guild] of c.guilds.cache) {
        await guild.commands.set(COMMANDS); // instant, unlike global
      }
      console.log(`[discord] commands registered in ${c.guilds.cache.size} server(s)`);
    } catch (err) {
      console.error("[discord] could not register commands:", err.message);
    }
  });

  // A bot added to a new server should work there immediately.
  client.on(Events.GuildCreate, async (guild) => {
    try {
      await guild.commands.set(COMMANDS);
      console.log(`[discord] joined ${guild.name}, commands registered`);
    } catch (err) {
      console.error(`[discord] could not register commands in ${guild.name}:`, err.message);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    /* The right-click menu. Answered privately: the person asked the bot to
       remember something, which is between them and the bot — announcing it
       to the channel would be both noise and a small betrayal. */
    if (interaction.isMessageContextMenuCommand?.() && interaction.commandName === "Remember this") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      const target = interaction.targetMessage;
      const body = (target?.content ?? "").trim();
      if (!body) {
        return interaction.editReply("There's no text in that message for me to keep.").catch(() => {});
      }
      const who = target.author?.username ?? "someone";
      const where = target.channel?.name ? ` in #${target.channel.name}` : "";
      const said =
        `I'm keeping something ${who} said${where}. Keep it, and say briefly what you've kept.` +
        `\n\n"""\n${body.slice(0, 1500)}\n"""`;
      try {
        const { reply } = await respond({
          surface: "discord",
          surfaceUserId: interaction.user.id,
          displayName: interaction.user.username,
          text: said,
        });
        return interaction.editReply(reply.slice(0, 1900)).catch(() => {});
      } catch (err) {
        console.error("[discord] remember-this failed:", err.message);
        return interaction.editReply("I couldn't keep that just now. Try again in a moment.").catch(() => {});
      }
    }

    if (!interaction.isChatInputCommand()) return;

    // Our turns take seconds; Discord wants an acknowledgement within three.
    // Everything here is about one person, so keep it to them.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    // /forget sits one click away in the command menu, and it is not the kind
    // of thing to action on a misclick. Confirm it here rather than acting.
    if (interaction.commandName === "forget") {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("forget:yes").setLabel("Yes, stop remembering me").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("forget:no").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      );
      return interaction.editReply({
        content:
          "Straight answer: what's already written to Walrus can't be deleted — those blobs live " +
          "there until their storage epochs lapse, and a delete button here would be lying to you. " +
          "What I can do is stop recording and stop reading you back. Sure?",
        components: [row],
      }).catch(() => {});
    }

    /* Built from the command's own name rather than matched one by one.
       The chain this replaces listed seven commands explicitly and fell
       through to /help for anything else, so /study, /quiz, /plans, /stack
       and /kb were all registered, all tappable, and all silently answered
       with the help text. A command added to the menu now dispatches on its
       own; only the ones taking an argument or wearing a different name here
       need saying. */
    const ARG_OF = { shot: "url", search: "query", link: "code", mode: "which", kb: "query" };
    const CALLED = { remember: "whatyouknow", forget: "forgetme" };

    const name = CALLED[interaction.commandName] ?? interaction.commandName;
    const argName = ARG_OF[interaction.commandName];
    const arg = argName ? interaction.options.getString(argName) : null;
    const text = `/${name}${arg ? ` ${arg}` : ""}`;

    try {
      const stream = streamer((t) => interaction.editReply(t));
      const { reply, image, actions, data } = await respond({
        surface: "discord",
        surfaceUserId: interaction.user.id,
        displayName: interaction.user.username,
        text,
        onDelta: (chunk) => stream.onDelta(chunk),
      });
      await stream.finish(reply);
      const components = rowsFor(actions);
      await interaction.editReply(
        image
          ? { content: chunk(reply)[0], files: [{ attachment: image.png, name: image.name ?? "shot.png" }], components }
          : bodyFor(reply, data, components),
      );
    } catch (err) {
      console.error("[discord] command failed:", err.message);
      await interaction.editReply("That didn't go through. Try again in a moment.").catch(() => {});
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("forget:")) return;
    if (interaction.customId === "forget:no") {
      return interaction.update({ content: "Left everything as it was.", components: [] }).catch(() => {});
    }
    await interaction.deferUpdate().catch(() => {});
    try {
      const { reply } = await respond({
        surface: "discord",
        surfaceUserId: interaction.user.id,
        text: "/forgetme confirm",
      });
      await interaction.editReply({ content: chunk(reply)[0], components: [] });
    } catch {
      await interaction.editReply({ content: "That didn't go through. Try again in a moment.", components: [] }).catch(() => {});
    }
  });

  /**
   * A tapped quick action runs the command it stands for, through exactly the
   * same path as typing it would: same memory, same writes. The answer comes
   * back as a new private message rather than replacing the buttons, so the
   * row stays where it is and can be used again.
   */
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("do:")) return;
    const action = ACTIONS[interaction.customId.slice(3)];
    if (!action?.say) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    try {
      const { reply, actions, data } = await respond({
        surface: "discord",
        surfaceUserId: interaction.user.id,
        displayName: interaction.user.username,
        text: action.say,
      });
      await interaction.editReply(bodyFor(reply, data, rowsFor(actions)));
    } catch (err) {
      console.error(`[discord] button ${interaction.customId} failed:`, err.message);
      await interaction.editReply("That didn't go through. Try again in a moment.").catch(() => {});
    }
  });

  // People who have been told, this process, that a channel is public. A reply
  // in a channel is visible to everyone in it, and it still goes into their
  // memory — worth saying once, and only once.
  const warnedInPublic = new Set();

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;

    const isDM = !msg.guild;
    const mentioned = msg.mentions.users.has(client.user.id);

    let text = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();

    // A file posted on its own has no content at all. Returning early on empty
    // text meant every attachment sent to this bot was thrown away.
    const file = [...msg.attachments.values()].find(USABLE);
    if (!text && !file) return;

    /**
     * People type "/link ABC123" as plain text in a channel — Discord's command
     * picker doesn't match it, so it sends as an ordinary message. Ignoring
     * those was a dead end: the code was right there and nothing happened.
     *
     * So a command-shaped message is answered even without a mention. Ordinary
     * chatter in a channel still needs one, otherwise the bot would answer the
     * whole room and write everyone's conversation to Walrus.
     */
    const looksLikeCommand = /^\/?(link|help|start|menu|remember|whatyouknow|forget|forgetme|shot|screenshot|search)\b/i.test(text);
    if (!isDM && !mentioned && !looksLikeCommand) return;

    // Anything that would print someone's memories belongs where only they can
    // read it. Point at the slash command, which replies privately.
    if (!isDM && /^\/?(remember|whatyouknow|forget|forgetme)\b/i.test(text)) {
      return void msg.reply(
        "That one's private — use `/remember` or `/forget` from the command menu and only you'll see it. Or just DM me.",
      ).catch(() => {});
    }

    // People type "link ABC123" without the slash, especially after being told
    // to send a code. Accept it rather than answering as if it were chatter.
    const bare = text.match(/^(link|help|menu|remember|forget)\b\s*([A-Za-z0-9]{6})?$/i);
    if (bare) {
      const verb = bare[1].toLowerCase();
      text =
        verb === "link" ? (bare[2] ? `/link ${bare[2]}` : "/link")
        : verb === "remember" ? "/whatyouknow"
        : verb === "forget" ? "/forgetme"
        : verb === "menu" ? "/menu"
        : "/help";
    }

    try {
      await msg.channel.sendTyping();

      // Post a first fragment as soon as there is one and edit it as the rest
      // arrives, rather than leaving the channel silent for the whole turn.
      let placeholder = null;
      const stream = streamer(async (t) => {
        if (placeholder) await placeholder.edit(t);
        else placeholder = await msg.reply(t);
      });

      // Same pipeline as a web upload or a Telegram photo: described once,
      // kept once, and findable later by what is in it.
      let attachment = null;
      if (file) {
        attachment = await fetchAttachment(file, text)
          .catch((err) => { console.error("[discord] could not read attachment:", err.message); return null; });
      }

      const { reply, image, actions } = await respond({
        surface: "discord",
        surfaceUserId: msg.author.id,
        displayName: msg.author.username,
        text: text || "What do you make of this?",
        attachment,
        onDelta: (c) => stream.onDelta(c),
      });
      await stream.finish(reply);
      // Only a command comes back with these, so ordinary chatter in a
      // channel never sprouts buttons.
      const components = rowsFor(actions);

      let out = reply;
      if (!isDM && !warnedInPublic.has(msg.author.id)) {
        warnedInPublic.add(msg.author.id);
        out += `\n\n-# Everyone here can read this, and I'll remember it. DM me if you'd rather it stayed between us.`;
      }

      const parts = chunk(out);
      if (image) {
        const body = { content: parts[0], files: [{ attachment: image.png, name: image.name ?? "shot.png" }], components };
        if (placeholder) await placeholder.delete().catch(() => {});
        await msg.reply(body);
      } else if (placeholder) {
        await placeholder.edit({ content: parts[0], components }).catch(() => {});
        for (const extra of parts.slice(1)) await msg.reply(extra);
      } else {
        await msg.reply({ content: parts[0], components });
        for (const extra of parts.slice(1)) await msg.reply(extra);
      }
    } catch (err) {
      console.error("[discord] handler error:", err.message);
      await msg.reply("Something went wrong handling that. Try again in a moment.").catch(() => {});
    }
  });

  await client.login(token);
  return { stop: () => client.destroy() };
}

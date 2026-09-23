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
  Client, GatewayIntentBits, Partials, Events, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { respond } from "../core/session.mjs";

const DISCORD_LIMIT = 2000;

const COMMANDS = [
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
  { name: "remember", description: "Show everything I remember about you" },
  { name: "forget", description: "Stop remembering me" },
  { name: "help", description: "What I can do" },
];

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

    const code = interaction.options.getString("code");
    const text =
      interaction.commandName === "shot" ? `/shot ${interaction.options.getString("url")}`
      : interaction.commandName === "search" ? `/search ${interaction.options.getString("query")}`
      : interaction.commandName === "link" ? (code ? `/link ${code}` : "/link")
      : interaction.commandName === "remember" ? "/whatyouknow"
      : interaction.commandName === "forget" ? "/forgetme"
      : "/help";

    try {
      const { reply, image } = await respond({
        surface: "discord",
        surfaceUserId: interaction.user.id,
        displayName: interaction.user.username,
        text,
      });
      await interaction.editReply(
        image
          ? { content: chunk(reply)[0], files: [{ attachment: image.png, name: image.name ?? "shot.png" }] }
          : chunk(reply)[0],
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

  // People who have been told, this process, that a channel is public. A reply
  // in a channel is visible to everyone in it, and it still goes into their
  // memory — worth saying once, and only once.
  const warnedInPublic = new Set();

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;

    const isDM = !msg.guild;
    const mentioned = msg.mentions.users.has(client.user.id);

    let text = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
    if (!text) return;

    /**
     * People type "/link ABC123" as plain text in a channel — Discord's command
     * picker doesn't match it, so it sends as an ordinary message. Ignoring
     * those was a dead end: the code was right there and nothing happened.
     *
     * So a command-shaped message is answered even without a mention. Ordinary
     * chatter in a channel still needs one, otherwise the bot would answer the
     * whole room and write everyone's conversation to Walrus.
     */
    const looksLikeCommand = /^\/?(link|help|start|remember|whatyouknow|forget|forgetme|shot|screenshot|search)\b/i.test(text);
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
    const bare = text.match(/^(link|help|remember|forget)\b\s*([A-Za-z0-9]{6})?$/i);
    if (bare) {
      const verb = bare[1].toLowerCase();
      text =
        verb === "link" ? (bare[2] ? `/link ${bare[2]}` : "/link")
        : verb === "remember" ? "/whatyouknow"
        : verb === "forget" ? "/forgetme"
        : "/help";
    }

    try {
      await msg.channel.sendTyping();
      const { reply, image } = await respond({
        surface: "discord",
        surfaceUserId: msg.author.id,
        displayName: msg.author.username,
        text,
      });
      let out = reply;
      if (!isDM && !warnedInPublic.has(msg.author.id)) {
        warnedInPublic.add(msg.author.id);
        out += `\n\n-# Everyone here can read this, and I'll remember it. DM me if you'd rather it stayed between us.`;
      }

      if (image) {
        await msg.reply({ content: chunk(out)[0], files: [{ attachment: image.png, name: image.name ?? "shot.png" }] });
      } else {
        for (const part of chunk(out)) await msg.reply(part);
      }
    } catch (err) {
      console.error("[discord] handler error:", err.message);
      await msg.reply("Something went wrong handling that. Try again in a moment.").catch(() => {});
    }
  });

  await client.login(token);
  return { stop: () => client.destroy() };
}

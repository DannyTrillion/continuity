/**
 * Process entry point: HTTP API + web chat, with the Telegram and Discord
 * adapters running alongside in the same process against the same memory.
 */

import { createServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { respond } from "./core/session.mjs";
import { health, recall, dedupe, personNs, suppressionsFor, withoutSuppressed, markWrong, findConflicts } from "./core/memory.mjs";
import { resolvePerson, lookupAccount, issueLinkCode, surfacesFor } from "./core/identity.mjs";
import { startOutbox, onSettled, outboxStats } from "./core/outbox.mjs";
import { issueMemoryKey, redeemMemoryKey, issueChallenge, takeChallenge, attachWallet } from "./core/recovery.mjs";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { snapshot } from "./core/metrics.mjs";
import { noteWrite, provenanceFor, provenanceStats } from "./core/provenance.mjs";
import { personaList, getPersona } from "./core/personas.mjs";
import { demoAllowance, recordDemoTurn, budgetSnapshot } from "./core/budget.mjs";
import { DEFAULT_MODEL } from "./core/llm.mjs";
import { startTelegram } from "./adapters/telegram.mjs";
import { startDiscord } from "./adapters/discord.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const LEDGER = process.env.LEDGER_PATH ?? join(here, "..", "blob-ledger.jsonl");

/**
 * Every confirmed write, appended with its blob id. This is the receipt rule
 * made visible: the ledger is the evidence that a memory is really on Walrus
 * and not just in a log line claiming success.
 */
const recentWrites = [];
onSettled(async ({ job, ok, stored = [], error }) => {
  if (!ok) {
    console.error(`[memory] write abandoned (${job.kind} → ${job.namespace}):`, error);
    return;
  }
  for (const s of stored) {
    noteWrite(s.blobId, job.surface);
    const row = { at: new Date().toISOString(), blobId: s.blobId, namespace: s.namespace, kind: job.kind };
    recentWrites.unshift(row);
    recentWrites.length = Math.min(recentWrites.length, 50);
    console.log(`mem+ ${s.namespace} [${s.blobId}]`);
    await appendFile(LEDGER, JSON.stringify(row) + "\n").catch(() => {});
  }
});
startOutbox();

/**
 * Health is polled in the background and served from memory.
 *
 * The relayer's own health endpoint is as flaky as the rest of it, so a request
 * that waits on it reports the relayer's mood rather than whether this app
 * works — and one slow call was enough to show a visitor a red "Reconnecting"
 * while everything was fine. A single failure is noise; two in a row is a
 * signal, and only that turns the light off.
 */
let healthState = { ok: null, relayer: "unknown", writeReady: false, misses: 0 };

async function pollHealth() {
  try {
    const h = await health();
    healthState = {
      ok: h.status === "ok" && h.write_ready !== false,
      relayer: h.status,
      writeReady: h.write_ready !== false,
      misses: 0,
    };
  } catch {
    const misses = healthState.misses + 1;
    healthState = { ...healthState, misses, ok: misses >= 2 ? false : healthState.ok };
  }
}
pollHealth();
setInterval(pollHealth, 20_000).unref();

/** Screenshots come back as a PNG buffer; JSON can only carry it as a data URL. */
const withImage = (out) =>
  out.image
    ? { ...out, image: `data:image/png;base64,${Buffer.from(out.image.png).toString("base64")}` }
    : out;

/**
 * The person's name, if they happen to have mentioned it.
 *
 * Nobody is asked for a name — it arrives through conversation as an ordinary
 * memory ("Your name is Danny"), so it is read back out of the facts rather
 * than stored as a field. No name is fine; the UI just stays generic.
 */
function nameFrom(facts) {
  for (const f of facts) {
    const m = String(f.text).match(
      /\b(?:name (?:is|'s)|called|go(?:es)? by)\s+([A-Z][\p{L}'-]{1,23})/u,
    );
    if (m) return m[1];
  }
  return null;
}

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 100_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    });
    return res.end();
  }

  // Health is cached: the relayer call takes a second or two, and every visitor
  // polling it would both feel sluggish and add load for no new information.
  if (url.pathname === "/healthz") {
    return json(res, healthState.ok === false ? 503 : 200, {
      ok: healthState.ok !== false,
      known: healthState.ok !== null,
      relayer: healthState.relayer,
      writeReady: healthState.writeReady,
      outbox: outboxStats(),
    });
  }

  // The ledger is public on purpose: anyone can take a blob id to Walruscan
  // and confirm this bot's memory is really on Walrus.
  if (url.pathname === "/api/ledger") {
    return json(res, 200, { writes: recentWrites });
  }

  // What the bot currently knows about one person, for the sidebar. Kept out
  // of the chat transcript so inspecting your own memory is not itself a turn
  // the bot then remembers.
  if (url.pathname === "/api/memory") {
    const userId = url.searchParams.get("userId");
    if (!userId) return json(res, 400, { error: "userId is required" });
    try {
      const who = await resolvePerson("web", userId);
      const sets = await Promise.all(
        who.namespaces.map((ns) => recall(ns, "anything about this person", { limit: 12, maxTokens: 900 })),
      );
      // Every recalled memory knows which blob holds it, so each fact can be
      // checked individually on Walruscan. "Trust me, it's on Walrus" is a
      // claim; a blob id per sentence is evidence.
      const suppressed = await suppressionsFor(who.personId).catch(() => new Set());
      const facts = dedupe(withoutSuppressed(sets.flat(), suppressed))
        .sort((a, b) => a.distance - b.distance)
        .map((h) => ({ text: h.text, at: h.created_at, blobId: h.blob_id ?? null }));
      const connected = await surfacesFor(who.personId);
      return json(res, 200, {
        personId: who.personId,
        linked: connected.length > 1,
        connected,
        name: nameFrom(facts),
        facts,
      });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  // Everything the console's instrument panel needs, in one call.
  if (url.pathname === "/api/stats") {
    const m = snapshot();
    return json(res, 200, {
      model: DEFAULT_MODEL,
      metrics: m,
      outbox: outboxStats(),
      blobsLedger: recentWrites.length,
      surfaces: {
        web: true,
        telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        discord: Boolean(process.env.DISCORD_BOT_TOKEN),
      },
      botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "walrusmemory_bot",
      // Two different things, deliberately separated: joining the server where
      // the bot already runs, versus installing it into your own.
      discordInvite: process.env.DISCORD_INVITE_URL ?? null,
      discordInstall: process.env.DISCORD_CLIENT_ID
        ? `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&permissions=84992&scope=bot%20applications.commands`
        : null,
    });
  }

  // Everything the dashboard needs, in one call.
  if (url.pathname === "/api/memory/full") {
    const userId = url.searchParams.get("userId");
    if (!userId) return json(res, 400, { error: "userId is required" });
    try {
      const who = await resolvePerson("web", userId);
      const [sets, suppressed, connected] = await Promise.all([
        Promise.all(who.namespaces.map((ns) =>
          recall(ns, "everything known about this person", { limit: 12, maxTokens: 1800 }))),
        suppressionsFor(who.personId).catch(() => new Set()),
        surfacesFor(who.personId).catch(() => []),
      ]);

      const live = withoutSuppressed(sets.flat(), suppressed);
      // Conflicts come from the UNcollapsed set: dedupe's whole job is to hide
      // these, and hiding them is what the dashboard exists to stop.
      const conflicts = findConflicts(live);
      const collapsed = dedupe(live);

      const facts = collapsed
        .sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0))
        .map((h) => ({
          text: h.text,
          at: h.created_at,
          blobId: h.blob_id ?? null,
          distance: Number((h.distance ?? 0).toFixed(3)),
          provenance: h.blob_id ? provenanceFor(h.blob_id) : null,
        }));

      return json(res, 200, {
        personId: who.personId,
        name: nameFrom(facts),
        connected,
        facts,
        conflicts,
        stats: {
          total: facts.length,
          collapsed: live.length - collapsed.length,
          suppressed: suppressed.size,
          namespaces: who.namespaces.length,
          crossSurface: facts.filter((f) => f.provenance?.crossed).length,
          neverRead: facts.filter((f) => (f.provenance?.readCount ?? 0) === 0).length,
          ...provenanceStats(),
        },
      });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  // "That's not right" — we cannot unwrite a blob, so we stop reading it back.
  if (url.pathname === "/api/memory/forget" && req.method === "POST") {
    try {
      const { userId, text } = await readBody(req);
      if (!userId || !text) return json(res, 400, { error: "userId and text are required" });
      const who = await resolvePerson("web", String(userId));
      await markWrong(who.personId, String(text));
      return json(res, 200, {
        ok: true,
        note: "I'll stop using that. The blob itself stays on Walrus — append-only storage means I can't unwrite it, and I'd rather say so.",
      });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  /* ── the live demo ── */

  if (url.pathname === "/api/demo/personas") {
    return json(res, 200, { personas: personaList(), budget: budgetSnapshot() });
  }

  // A visitor is a real person with real memories, kept on its own surface so
  // demo traffic never mixes with people using the actual web chat.
  if (url.pathname === "/api/demo/chat" && req.method === "POST") {
    try {
      const { personaId, visitorId, text } = await readBody(req);
      const persona = getPersona(String(personaId));
      if (!persona || !visitorId || !text) {
        return json(res, 400, { error: "personaId, visitorId and text are required" });
      }

      const allowance = demoAllowance(String(visitorId));
      if (!allowance.allowed) {
        return json(res, 429, {
          error:
            allowance.turnsLeft === 0
              ? "That's the demo limit for this hour — it shares a quota with the live bot. Open the real chat to keep going."
              : "The hourly quota is nearly spent. Try again shortly.",
          allowance,
        });
      }

      const out = await respond({
        surface: "demo",
        surfaceUserId: `${persona.id}:${visitorId}`,
        text: String(text),
        persona,
        // Under pressure the demo still answers from memory, it just stops
        // adding to it. Saying so beats quietly forgetting the visitor.
        remember: allowance.write,
      });

      recordDemoTurn(String(visitorId), { wrote: allowance.write });
      return json(res, 200, {
        ...withImage(out),
        remembering: allowance.write,
        allowance: demoAllowance(String(visitorId)),
      });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  // Carry a demo conversation onto Telegram, which is the whole point.
  if (url.pathname === "/api/demo/link" && req.method === "POST") {
    try {
      const { personaId, visitorId } = await readBody(req);
      const persona = getPersona(String(personaId));
      if (!persona || !visitorId) return json(res, 400, { error: "personaId and visitorId are required" });

      const me = await lookupAccount("demo", `${persona.id}:${visitorId}`);
      if (!me) return json(res, 409, { error: "Say something first — there's nothing to carry over yet." });

      const { code, expiresInMinutes } = issueLinkCode(me.personId, "demo");
      const bot = process.env.TELEGRAM_BOT_USERNAME ?? "walrusmemory_bot";
      return json(res, 200, {
        code,
        expiresInMinutes,
        telegram: `https://t.me/${bot}?start=${code}`,
        discord: process.env.DISCORD_INVITE_URL ?? null,
      });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  /* ── carrying an existing web session onto another app ── */

  // A link code without going through the chat, so the landing page can hand a
  // returning visitor a Telegram deep link that already carries it.
  if (url.pathname === "/api/link/code" && req.method === "POST") {
    try {
      const { userId } = await readBody(req);
      if (!userId) return json(res, 400, { error: "userId is required" });
      const me = await lookupAccount("web", String(userId));
      // Only for someone we already know. A brand-new visitor needs no code —
      // they have no memory to carry — and issuing one would mint a person.
      if (!me) return json(res, 204, {});
      return json(res, 200, { ...issueLinkCode(me.personId, "web"), personId: me.personId });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  /* ── being yourself again on another browser ── */

  if (url.pathname === "/api/key/issue" && req.method === "POST") {
    try {
      const { userId } = await readBody(req);
      if (!userId) return json(res, 400, { error: "userId is required" });
      return json(res, 200, await issueMemoryKey(String(userId)));
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  if (url.pathname === "/api/key/redeem" && req.method === "POST") {
    try {
      const { phrase } = await readBody(req);
      if (!phrase) return json(res, 400, { error: "phrase is required" });
      const out = await redeemMemoryKey(String(phrase));
      // Deliberately vague about which part was wrong, and deliberately slow:
      // this endpoint is the only place a key can be tested.
      if (!out.ok) {
        await new Promise((r) => setTimeout(r, 600));
        return json(res, 404, { error: "That key doesn't match anything I've stored." });
      }
      return json(res, 200, out);
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  if (url.pathname === "/api/wallet/challenge" && req.method === "POST") {
    try {
      const { userId } = await readBody(req);
      if (!userId) return json(res, 400, { error: "userId is required" });
      return json(res, 200, issueChallenge(String(userId)));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (url.pathname === "/api/wallet/verify" && req.method === "POST") {
    try {
      const { nonce, signature, message } = await readBody(req);
      const challenge = takeChallenge(String(nonce));
      if (!challenge) return json(res, 400, { error: "That sign-in request expired. Try again." });
      if (message !== `Continuity — prove this wallet is yours so your memory follows it.\n\nNonce: ${nonce}`) {
        return json(res, 400, { error: "signed the wrong message" });
      }

      // The signature proves the address; we never take an address on trust.
      const publicKey = await verifyPersonalMessageSignature(
        new TextEncoder().encode(message),
        signature,
      );
      const address = publicKey.toSuiAddress();

      return json(res, 200, { ...(await attachWallet(address, challenge.userId)), address });
    } catch (err) {
      return json(res, 400, { error: "Couldn't verify that signature." , detail: err.message });
    }
  }

  // Streaming chat. Same turn, delivered as server-sent events so the first
  // words appear in about a second instead of after the whole reply.
  if (url.pathname === "/api/chat/stream" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    const { userId, text } = body;
    if (!userId || !text) return json(res, 400, { error: "userId and text are required" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      // Proxies that buffer would defeat the whole point.
      "X-Accel-Buffering": "no",
    });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    try {
      const out = await respond({
        surface: "web",
        surfaceUserId: String(userId),
        text: String(text),
        onDelta: (t) => send({ t }),
      });
      // A command reply never streams, so send it whole.
      send({ done: true, ...withImage(out) });
    } catch (err) {
      send({ done: true, error: err.message });
    }
    return res.end();
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    try {
      const { userId, text } = await readBody(req);
      if (!userId || !text) return json(res, 400, { error: "userId and text are required" });
      const out = await respond({
        surface: "web",
        surfaceUserId: String(userId),
        text: String(text),
      });
      return json(res, 200, withImage(out));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

// "/" is the landing page; "/chat" is the app itself.
  const PAGES = {
    "/": "index.html", "/index.html": "index.html",
    "/demo": "demo.html", "/demo.html": "demo.html",
    "/memory": "memory.html", "/memory.html": "memory.html",
    "/chat": "chat.html", "/chat.html": "chat.html",
    "/use-cases": "use-cases.html", "/use-cases.html": "use-cases.html",
  };
  if (PAGES[url.pathname]) {
    try {
      const html = await readFile(join(here, "web", PAGES[url.pathname]));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      return json(res, 500, { error: "page not built" });
    }
  }

  // The captured transcripts behind the use-cases page.
  if (url.pathname === "/cases.json") {
    try {
      const body = JSON.parse(await readFile(join(here, "web", "cases.json"), "utf8"));
      // A capture where nothing carried across is a transcript of the bot
      // forgetting. Keep it out rather than publish it as proof of memory.
      const usable = body.filter((c) => (c.carried?.length ?? 0) > 0);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" });
      return res.end(JSON.stringify(usable));
    } catch {
      return json(res, 200, []); // not captured yet
    }
  }

  // Static assets that live beside the pages (the background texture).
  const asset = url.pathname.match(/^\/assets\/([\w.-]+)$/);
  if (asset) {
    try {
      const body = await readFile(join(here, "web", "assets", asset[1]));
      const ext = asset[1].split(".").pop().toLowerCase();
      const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml" }[ext];
      res.writeHead(200, { "Content-Type": type ?? "application/octet-stream", "Cache-Control": "public, max-age=86400" });
      return res.end(body);
    } catch {
      return json(res, 404, { error: "not found" });
    }
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`[web] listening on :${PORT}`));

/**
 * Bring a surface up, and keep trying.
 *
 * A single transient `fetch failed` at boot used to disable a surface for the
 * lifetime of the process — so a deploy that happened to land during a network
 * blip came up silently missing Telegram or Discord, with nothing but one line
 * in the log to say so.
 */
function startSurface(name, start, token) {
  if (!token) {
    console.log(`[${name}] no token, surface disabled`);
    return;
  }
  let attempt = 0;
  const tryStart = () => {
    start({ token }).catch((err) => {
      attempt += 1;
      const wait = Math.min(5000 * 2 ** (attempt - 1), 60_000);
      console.error(
        `[${name}] failed to start (attempt ${attempt}), retrying in ${wait / 1000}s:`,
        err.message,
      );
      setTimeout(tryStart, wait);
    });
  };
  tryStart();
}

startSurface("telegram", startTelegram, process.env.TELEGRAM_BOT_TOKEN);
startSurface("discord", startDiscord, process.env.DISCORD_BOT_TOKEN);

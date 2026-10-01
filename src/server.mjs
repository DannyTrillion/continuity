/**
 * Process entry point: HTTP API + web chat, with the Telegram and Discord
 * adapters running alongside in the same process against the same memory.
 */

import { createServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { respond } from "./core/session.mjs";
import { health, recall, dedupe, personNs, suppressionsFor, withoutSuppressed, markWrong, findConflicts, NS_INDEX } from "./core/memory.mjs";
import { resolvePerson, lookupAccount, issueLinkCode, surfacesFor } from "./core/identity.mjs";
import { startOutbox, onSettled, outboxStats, pendingFor, FILE as OUTBOX_FILE } from "./core/outbox.mjs";
import { list as listConversations, get as getConversation, flushAll } from "./core/conversations.mjs";
import { resume, hasHistory } from "./core/session.mjs";
import { issueMemoryKey, redeemMemoryKey, issueChallenge, takeChallenge, attachWallet } from "./core/recovery.mjs";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { snapshot } from "./core/metrics.mjs";
import { storeAttachment, listImages, UPLOADS } from "./core/images.mjs";
import { saveStep, savePicture, finish as finishOnboarding, receiptsFor, stateFor } from "./core/onboard.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile as writeFileAsync } from "node:fs/promises";
import { noteWrite, provenanceFor, provenanceStats, FILE as PROVENANCE_FILE } from "./core/provenance.mjs";
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

/**
 * Reload the tail of the ledger at boot.
 *
 * The ledger is the evidence this whole project rests on — real blob ids
 * anyone can open on Walruscan. It was appended to a file and kept in memory,
 * but never read back, so every restart served an empty proof list while the
 * file sat there full. Someone arriving just after a deploy saw a bot that
 * claimed to write to Walrus and could not show a single blob for it.
 */
try {
  if (existsSync(LEDGER)) {
    const lines = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines.slice(-50).reverse()) {
      try { recentWrites.push(JSON.parse(line)); } catch { /* skip a torn line */ }
    }
    if (recentWrites.length) console.log(`[ledger] restored ${recentWrites.length} write(s) from disk`);
  }
} catch (err) {
  console.warn("[ledger] could not restore:", err.message);
}
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
let healthState = { ok: null, relayer: "unknown", writeReady: true, misses: 0, notReady: 0 };

async function pollHealth() {
  try {
    const h = await health();
    /**
     * `write_ready` flaps. Polling it a few seconds apart returns false and
     * then true with nothing wrong in between, and a single false used to make
     * the whole service report unhealthy: /healthz answered 503, the status
     * light went red, and on a platform that health-checks this endpoint that
     * is an invitation to restart a container that was working fine.
     *
     * It does not deserve that weight. Writes go through the outbox, which
     * retries durably across restarts, so a momentary not-ready delays a blob
     * rather than losing it — and reads and replies are unaffected either way.
     * So liveness follows the relayer being reachable, and write readiness is
     * reported alongside it, only believed once it has said so twice running.
     */
    const notReady = h.write_ready === false ? healthState.notReady + 1 : 0;
    healthState = {
      ok: h.status === "ok",
      relayer: h.status,
      writeReady: notReady < 2,
      misses: 0,
      notReady,
    };
  } catch (err) {
    // A 429 is not an outage. The relayer received the request, understood it,
    // and answered — it is simply busy. Counting that as a miss meant a burst
    // of real traffic made the app light itself up red and tell every visitor
    // it was reconnecting, at the exact moment it was working hardest. Worse,
    // this poll spends the same rate-limit budget it was then misreporting.
    // Not always a clean 429: the relayer sometimes wraps a rate limit inside
    // a 500 with the real cause buried in the message, so the text is checked
    // too. Reading that as an outage is how a busy minute turned the status
    // light red while every request was still being served.
    const busy = err?.status === 429 ||
      /rate limit|too many requests/i.test(String(err?.message ?? ""));
    if (busy) {
      healthState = { ...healthState, relayer: "busy", misses: 0 };
      return;
    }
    const misses = healthState.misses + 1;
    healthState = { ...healthState, misses, ok: misses >= 2 ? false : healthState.ok };
  }
}
pollHealth();
// Every 20s was 180 requests an hour spent on a status dot, out of an account
// budget of 1000 — and it counted against the 60-per-minute burst limit that
// real turns need. A minute is fresh enough for a liveness light.
setInterval(pollHealth, 60_000).unref();

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
/**
 * The sentence inside a queued analyze job.
 *
 * A job carries the turn as the extractor needs to see it: prefixed with the
 * surface, and sometimes trailed by what the assistant had just asked so the
 * extractor can tell an answer from an assertion. That envelope is machinery.
 * Once the job lands, what gets stored is a clean fact; until then the
 * dashboard shows the person's own sentence rather than the plumbing.
 */
const sentenceOf = (text) =>
  String(text ?? "")
    .replace(/^On \w+, the user said:\s*/, "")
    .replace(/\n\(That was their answer to[\s\S]*$/, "")
    .trim();

/**
 * Is this worth showing as a memory in progress?
 *
 * Every turn is queued for extraction, including the ones that teach nothing.
 * "what do you already know about me?" is a question, and showing someone
 * their own question back as something learned about them makes the page look
 * broken. The extractor drops these anyway; this just keeps them off the page
 * during the seconds before it does.
 */
const worthShowing = (s) =>
  s.length > 2 && !/^(what|who|where|when|why|how|do|does|did|can|could|is|are|was|were|will|would|should|tell|show|remind)\b[\s\S]*\?$/i.test(s);

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

// 100KB is right for a chat message and far too small for a file: an ordinary
// screenshot arrives as several megabytes of base64. The cap is per-route now.
/**
 * Read a JSON body, refusing anything over `maxBytes`.
 *
 * Two things here are less obvious than they look.
 *
 * Chunks are measured as bytes, not as string length. Concatenating Buffers
 * onto a string counts UTF-16 code units, so a body of multibyte characters
 * was measured at roughly half its real size and the cap let it through.
 *
 * And on overflow the request has to be DRAINED, not just abandoned. Rejecting
 * the promise while the client is still uploading left an undrained socket:
 * our 413 went out, the upload kept coming, the connection broke mid-flight,
 * and Railway's proxy turned the whole thing into a 502. Refusing a large file
 * should look like a refusal, not like a crash. So overflow stops accumulating,
 * drains the rest, and lets the response go out on a healthy connection.
 */
const readBody = (req, maxBytes = 100_000) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;

    req.on("data", (c) => {
      if (over) return; // draining; hold nothing
      size += c.length;
      if (size > maxBytes) {
        over = true;
        chunks.length = 0;
        req.resume(); // let the client finish so the 413 is actually delivered
        const err = new Error("That's too large to send in one message.");
        err.status = 413;
        return reject(err);
      }
      chunks.push(c);
    });

    req.on("aborted", () => {
      const err = new Error("upload interrupted");
      err.status = 400;
      reject(err);
    });
    req.on("error", reject);

    req.on("end", () => {
      if (over) return; // already rejected
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        const err = new Error("invalid JSON");
        err.status = 400;
        reject(err);
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
    // The state report is not decoration. Every one of these files is state we
    // promised would survive a restart — the outbox above all, whose entire
    // job is to keep retrying a write across one. On a container with no
    // volume mounted they sit on an ephemeral filesystem and are silently
    // wiped by each deploy, and nothing about that failure is visible from the
    // outside: the bot looks healthy and just quietly loses pending memories.
    // So the paths, and whether they are actually on the volume, are reported.
    const state = Object.fromEntries(
      Object.entries({
        outbox: OUTBOX_FILE, namespaces: NS_INDEX, provenance: PROVENANCE_FILE,
        ledger: LEDGER, uploads: UPLOADS,
      }).map(([k, p]) => [k, { path: p, exists: existsSync(p) }]),
    );
    // 503 means "do not send traffic here". That is true when the relayer is
    // unreachable, not when it is briefly declining writes.
    return json(res, healthState.ok === false ? 503 : 200, {
      ok: healthState.ok !== false,
      known: healthState.ok !== null,
      relayer: healthState.relayer,
      writeReady: healthState.writeReady,
      outbox: outboxStats(),
      durable: Object.values(state).every((v) => v.path.startsWith("/data")),
      state,
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
      // Only identity is allowed to fail the request: without a person there
      // is nothing to show. Everything after it degrades instead, because a
      // relayer wobble blanking the whole dashboard is a worse answer than a
      // partial one — and this page is the evidence that the memory is real.
      const who = await resolvePerson("web", userId);
      const sets = await Promise.all(
        who.namespaces.map((ns) =>
          recall(ns, "anything about this person", { limit: 12, maxTokens: 900 }).catch((err) => {
            console.warn(`[memory] dashboard recall failed for ${ns}:`, err.message);
            return [];
          }),
        ),
      );
      // Every recalled memory knows which blob holds it, so each fact can be
      // checked individually on Walruscan. "Trust me, it's on Walrus" is a
      // claim; a blob id per sentence is evidence.
      const suppressed = await suppressionsFor(who.personId).catch(() => new Set());
      const landed = dedupe(withoutSuppressed(sets.flat(), suppressed))
        .sort((a, b) => a.distance - b.distance)
        .map((h) => ({ text: h.text, at: h.created_at, blobId: h.blob_id ?? null }));

      /* Writes take seconds, so a memory made a moment ago is in the outbox
         rather than on Walrus, and a page that showed only what had landed
         told a new person it knew nothing about them. Queued memories are
         shown too, marked as still saving and without a blob id — there is
         no receipt to show yet, and inventing one would defeat the point. */
      const queued = withoutSuppressed(
        who.namespaces
          .flatMap((ns) => pendingFor(ns))
          .map((j) => ({ text: sentenceOf(j.text), at: j.createdAt }))
          .filter((h) => worthShowing(h.text)),
        suppressed,
      ).map((h) => ({ ...h, blobId: null, saving: true }));

      const facts = [...landed, ...queued];
      const connected = await surfacesFor(who.personId).catch(() => ["web"]);
      return json(res, 200, {
        personId: who.personId,
        linked: connected.length > 1,
        connected,
        name: nameFrom(facts),
        facts,
        saving: queued.length,
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
      const [sets, suppressed, connected, pictures] = await Promise.all([
        Promise.all(who.namespaces.map((ns) =>
          recall(ns, "everything known about this person", { limit: 12, maxTokens: 1800 }))),
        suppressionsFor(who.personId).catch(() => new Set()),
        surfacesFor(who.personId).catch(() => []),
        // Pictures are memories too, kept in their own namespace; the
        // dashboard shows them as a collection beside the written ones.
        listImages(who.personId).catch(() => []),
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
        pictures,
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

  /* ── attachments ── */

  /**
   * An image cannot be a memory: Walrus Memory stores text. What CAN be a
   * memory is a description of it, and a good one outlives the file — "a 403
   * from publisher.walrus.space with no Authorization header" is worth
   * carrying to Telegram, the PNG is not.
   *
   * So the bytes are kept and served back, and the description goes into
   * memory like anything else said in the conversation.
   */
  if (url.pathname === "/api/attach" && req.method === "POST") {
    try {
      let body;
      try {
        body = await readBody(req, 12 * 1024 * 1024);
      } catch (err) {
        return json(res, err.status ?? 400, { error: err.message });
      }
      const { userId, name, type, data, hint } = body;
      if (!userId || !data) return json(res, 400, { error: "userId and data are required" });

      const bytes = Buffer.from(String(data).replace(/^data:[^,]+,/, ""), "base64");
      if (bytes.length > 8 * 1024 * 1024) {
        return json(res, 413, { error: "That file is over 8MB. Try a smaller one." });
      }

      // Shared with Telegram and Discord, so all three behave identically.
      return json(res, 200, await storeAttachment({ bytes, name, type, hint }));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // Files are served back from disk. On a platform with an ephemeral
  // filesystem these do not survive a redeploy — the DESCRIPTION does, because
  // that lives on Walrus, which is the part that had to be durable.
  const upload = url.pathname.match(/^\/uploads\/([\w.-]+)$/);
  if (upload) {
    try {
      const body = await readFile(join(UPLOADS, upload[1]));
      const ext = upload[1].split(".").pop().toLowerCase();
      const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
        webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown" }[ext];
      /**
       * Cache hard in production, never locally.
       *
       * A day-long cache is right for a texture served from Railway and
       * exactly wrong while someone is editing the stylesheet it is caching:
       * the server picks the change up on the next request and the browser
       * cheerfully ignores it, so the page looks unchanged and the edit looks
       * broken. Decided from the request's own host, so it needs no env var
       * and cannot be wrong about which one this is.
       */
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(req.headers.host ?? "");
      res.writeHead(200, {
        "Content-Type": type ?? "application/octet-stream",
        "Cache-Control": local ? "no-store" : "public, max-age=86400",
      });
      return res.end(body);
    } catch {
      return json(res, 404, { error: "That file is no longer here." });
    }
  }

  /* ── past conversations ── */

  if (url.pathname === "/api/conversations") {
    const userId = url.searchParams.get("userId");
    if (!userId) return json(res, 400, { error: "userId is required" });
    try {
      const who = await resolvePerson("web", userId);
      const all = await listConversations(who.personId);
      // The list only needs enough to recognise a conversation by.
      return json(res, 200, {
        conversations: all.map((c) => ({
          id: c.id, title: c.title, surface: c.surface,
          startedAt: c.startedAt, endedAt: c.endedAt,
          turns: c.turns.length, live: Boolean(c.live), blobId: c.blobId ?? null,
        })),
      });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  // Reopening one puts it back into short-term context, so the next message
  // continues the thread instead of starting a new one.
  if (url.pathname === "/api/conversations/open" && req.method === "POST") {
    try {
      const { userId, id } = await readBody(req);
      if (!userId || !id) return json(res, 400, { error: "userId and id are required" });
      const who = await resolvePerson("web", String(userId));
      const convo = await getConversation(who.personId, String(id));
      if (!convo) return json(res, 404, { error: "No such conversation." });
      const restored = resume(who.personId, convo.turns);
      return json(res, 200, { conversation: convo, restored });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  /**
   * A reloaded page bringing its own transcript back.
   *
   * The browser keeps the conversation on screen across reloads; this puts
   * it back into short-term context too, but only when the server has none —
   * after a redeploy, typically. If the server still remembers the last few
   * turns, its copy is the fresher one and wins.
   */
  if (url.pathname === "/api/session/restore" && req.method === "POST") {
    try {
      const { userId, turns } = await readBody(req);
      if (!userId || !Array.isArray(turns)) return json(res, 400, { error: "userId and turns are required" });
      const who = await resolvePerson("web", String(userId));
      if (hasHistory(who.personId)) return json(res, 200, { restored: 0, kept: true });
      const clean = turns.slice(-12).map((t) => ({ you: String(t?.you ?? "").slice(0, 4000), bot: String(t?.bot ?? "").slice(0, 8000) }));
      return json(res, 200, { restored: resume(who.personId, clean) });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  /* ── being introduced, once ── */

  // One step's answer, stored as a memory. The reply carries every receipt so
  // far, so the page can show each one landing without a second request.
  if (url.pathname === "/api/onboard/step" && req.method === "POST") {
    try {
      const { userId, step, value, attachment } = await readBody(req, 64 * 1024);
      if (!userId || !step) return json(res, 400, { error: "userId and step are required" });
      const name = step === "name" ? String(value ?? "").slice(0, 40) : undefined;
      const who = await resolvePerson("web", String(userId), name ? { displayName: name } : undefined);
      const saved = step === "picture" ? savePicture(who.personId, attachment, value) : saveStep(who.personId, String(step), value);
      return json(res, 200, { ok: true, saved: Boolean(saved), receipts: receiptsFor(who.personId) });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  if (url.pathname === "/api/onboard/status") {
    const userId = url.searchParams.get("userId");
    if (!userId) return json(res, 400, { error: "userId is required" });
    try {
      const me = await lookupAccount("web", String(userId));
      return json(res, 200, { receipts: me ? receiptsFor(me.personId) : [] });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  if (url.pathname === "/api/onboard/finish" && req.method === "POST") {
    try {
      const { userId, answers } = await readBody(req, 64 * 1024);
      if (!userId) return json(res, 400, { error: "userId is required" });
      const who = await resolvePerson("web", String(userId));
      finishOnboarding(who.personId, answers ?? {});
      return json(res, 200, { ok: true, receipts: receiptsFor(who.personId) });
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  // Asked only by the welcome page itself, when someone opens it again.
  if (url.pathname === "/api/onboard/state") {
    const userId = url.searchParams.get("userId");
    if (!userId) return json(res, 400, { error: "userId is required" });
    try {
      const me = await lookupAccount("web", String(userId));
      return json(res, 200, me ? await stateFor(me.personId) : { done: false });
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
    // `attachment` is the description and url produced by /api/attach, not the
    // bytes — those are already on disk. Leaving it out of this destructure
    // meant the streaming path silently dropped every attachment, so the model
    // was asked about an image it had never been told about.
    const { userId, text, attachment } = body;
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
        attachment,
        onDelta: (t) => send({ t }),
        onStage: (st) => send({ s: st }),
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
      const { userId, text, attachment } = await readBody(req);
      if (!userId || !text) return json(res, 400, { error: "userId and text are required" });
      const out = await respond({
        surface: "web",
        surfaceUserId: String(userId),
        text: String(text),
        attachment,
      });
      return json(res, 200, withImage(out));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /**
   * "/" is the landing page; the app itself is one document.
   *
   * Chat, memory and history are three panels in app.html, so all three paths
   * serve the same file and the router picks the panel from the path. That is
   * what makes moving between them instant: there is nothing to load.
   *
   * The paths stay real — a deep link, a bookmark or the back button all land
   * on the right section. The standalone pages are still served at their
   * .html names, so either half can be opened on its own when something breaks
   * and you need to know which one owns the bug.
   */
  const PAGES = {
    "/": "index.html", "/index.html": "index.html",
    "/demo": "demo.html", "/demo.html": "demo.html",
    "/chat": "app.html", "/memory": "app.html", "/history": "app.html",
    "/memory.html": "memory.html",
    "/history.html": "history.html",
    "/chat.html": "chat.html",
    "/use-cases": "use-cases.html", "/use-cases.html": "use-cases.html",
    "/docs": "docs.html", "/docs.html": "docs.html",
    "/welcome": "welcome.html", "/welcome.html": "welcome.html",
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

  // Static assets that live beside the pages: the texture, the stylesheets,
  // and one folder deep for the screenshots the capabilities page shows.
  const asset = url.pathname.match(/^\/assets\/((?:[\w-]+\/)?[\w.-]+)$/);
  if (asset) {
    try {
      const body = await readFile(join(here, "web", "assets", asset[1]));
      const ext = asset[1].split(".").pop().toLowerCase();
      const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml",
        css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
        json: "application/json; charset=utf-8" }[ext];
      /**
       * Cache hard in production, never locally.
       *
       * A day-long cache is right for a texture served from Railway and
       * exactly wrong while someone is editing the stylesheet it is caching:
       * the server picks the change up on the next request and the browser
       * cheerfully ignores it, so the page looks unchanged and the edit looks
       * broken. Decided from the request's own host, so it needs no env var
       * and cannot be wrong about which one this is.
       */
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(req.headers.host ?? "");
      res.writeHead(200, {
        "Content-Type": type ?? "application/octet-stream",
        "Cache-Control": local ? "no-store" : "public, max-age=86400",
      });
      return res.end(body);
    } catch {
      return json(res, 404, { error: "not found" });
    }
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`[web] listening on :${PORT}`));

// A conversation in progress is only in memory until it goes quiet. On a
// redeploy that would lose it, so save everything in flight on the way out.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    console.log(`[web] ${signal} — saving conversations in progress`);
    await flushAll().catch(() => {});
    process.exit(0);
  });
}

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

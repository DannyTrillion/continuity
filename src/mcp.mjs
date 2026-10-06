/**
 * Continuity's memory, as tools any other agent can call.
 *
 * WHY THIS EXISTS
 *
 * Three surfaces share one memory because I wrote three adapters that all call
 * `respond()`. That works, and it does not scale past the adapters I am willing
 * to write. Somebody building on Walrus who wants their app to remember its
 * users should not have to wait for me to add a fourth.
 *
 * MCP is the obvious shape for that. The identity model already has the right
 * bones: a person is an id, an account is `(surface, accountId)`, and
 * `adoptPerson` merges accounts by union rather than migration. Another app is
 * simply a new surface. Point a client at this and `mcp` joins web, telegram
 * and discord as somewhere the same person can be recognised.
 *
 * WHAT THIS IS NOT
 *
 * It is the server half only. Continuity exposes its memory here; it does not
 * yet call anybody else's tools, because the agent has no tool-calling loop —
 * `llm.mjs` sends a prompt and gets prose back. "Plug Continuity into a Walrus
 * app and it operates the app for you" needs that loop, and it is not built.
 * This is the half that is.
 *
 * NO NEW DEPENDENCY, ON PURPOSE
 *
 * A tools-only MCP server is a small JSON-RPC surface: `initialize`,
 * `tools/list`, `tools/call`, `ping`, and an `initialized` notification that
 * wants no answer. That is less code than the dependency's own wiring, and
 * this project ships four runtime dependencies three days before a deadline.
 * Adding a fifth to a Railway build on the Monday is a worse trade than
 * writing sixty lines of dispatch I can read.
 *
 *   stdio:  node src/mcp.mjs          (what a local client spawns)
 *   http:   POST /mcp on the server   (what a remote client posts to)
 *
 * Both call `dispatch()` below, so the two transports cannot drift apart.
 */

import { resolvePerson } from "./core/identity.mjs";
import { recall, rememberFact, personNs } from "./core/memory.mjs";
import { listFiles, findFiles, loadFile } from "./core/files.mjs";
import { listImages, findImages } from "./core/images.mjs";
import { memoryscan } from "./core/walrus.mjs";

export const PROTOCOL = "2025-06-18";

/* The surface name a client arrives on. Not configurable: it is half of the
   identity key, and letting a caller choose it would let one app claim another
   app's accounts. */
const SURFACE = "mcp";

/**
 * Who am I talking to?
 *
 * Every tool takes a `user` — whatever stable id the calling app already has
 * for its own user. It is scoped by surface, so `alice` here and `alice` on
 * Telegram are different accounts until a person links them deliberately. That
 * is the same rule the other three surfaces follow, and it is what stops a
 * guessable username from being a way to read somebody's memory.
 */
const whoFor = async (user) => {
  const id = String(user ?? "").trim();
  if (!id) throw new Error("every tool needs a `user`: a stable id for the person on your side");
  if (id.length > 200) throw new Error("that user id is implausibly long");
  return resolvePerson(SURFACE, id);
};

const text = (s) => ({ content: [{ type: "text", text: s }] });

/* A tool that throws should tell the calling model what went wrong rather than
   failing the JSON-RPC call, because an agent can recover from the first and
   not from the second. */
const failed = (message) => ({ content: [{ type: "text", text: message }], isError: true });

export const TOOLS = [
  {
    name: "recall",
    description:
      "Search what Continuity remembers about a person and get back the matching facts, " +
      "each with the Walrus blob id that holds it. Use this before answering anything " +
      "personal, so the answer comes from their memory rather than from a guess.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "A stable id for this person in your app." },
        query: { type: "string", description: "What you want to know, in plain words." },
        limit: { type: "integer", description: "How many facts to return. Default 8.", default: 8 },
      },
      required: ["user", "query"],
    },
    async run({ user, query, limit }) {
      const who = await whoFor(user);
      const hits = await recall(personNs(who.personId), String(query ?? ""),
        { limit: Math.min(Number(limit) || 8, 25) }).catch(() => []);
      if (!hits.length) {
        /* The distinction this whole project is about: nothing found is not the
           same as nothing stored, and an agent that conflates them will tell
           somebody it has forgotten them. */
        return text("No memories matched that. This can mean they are new, or that nothing " +
          "stored is relevant — it does not mean their memory is empty or broken.");
      }
      return text(hits.map((h) =>
        `• ${h.text}${h.blob_id ? `\n  walrus: ${h.blob_id}  ${memoryscan(h.blob_id)}` : ""}`).join("\n"));
    },
  },
  {
    name: "remember",
    description:
      "Write one fact about a person to Walrus so every app sharing this memory can read it " +
      "later, including Continuity's own web chat, Telegram and Discord. Write things that " +
      "will still be true next month, not what was said this turn.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "A stable id for this person in your app." },
        fact: { type: "string", description: "One durable fact, as a full sentence." },
      },
      required: ["user", "fact"],
    },
    async run({ user, fact }) {
      const who = await whoFor(user);
      const sentence = String(fact ?? "").trim();
      if (!sentence) return failed("Nothing to write.");
      if (sentence.length > 2000) return failed("That is too long for one fact. Split it up.");
      const res = await rememberFact(personNs(who.personId), sentence);
      /* The receipt rule, exported: a write is real when a blob id comes back,
         so the caller is handed the blob id rather than the word "ok". */
      return res?.blobId
        ? text(`Written. walrus: ${res.blobId}\n${memoryscan(res.blobId)}`)
        : text("Queued. The relayer has not confirmed it yet; it will land and is not lost.");
    },
  },
  {
    name: "list_files",
    description:
      "List the documents this person has shared with Continuity — on any surface — newest " +
      "first, with the Walrus blob id for each.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "A stable id for this person in your app." },
        limit: { type: "integer", description: "Default 20.", default: 20 },
      },
      required: ["user"],
    },
    async run({ user, limit }) {
      const who = await whoFor(user);
      const files = await listFiles(who.personId, { limit: Math.min(Number(limit) || 20, 60) });
      if (!files.length) return text("No files stored for this person.");
      return text(files.map((f) =>
        `• ${f.name ?? f.file}${f.at ? `  (${String(f.at).slice(0, 10)})` : ""}` +
        `${f.walrusBlob ? `\n  walrus: ${f.walrusBlob}` : "\n  (no blob — local only)"}`).join("\n"));
    },
  },
  {
    name: "find_file",
    description:
      "Find a document by describing it rather than naming it — 'the lease', 'my pharmacology " +
      "notes'. Returns the best matches with their blob ids. Use get_file to read one.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "A stable id for this person in your app." },
        query: { type: "string", description: "A description of the document." },
      },
      required: ["user", "query"],
    },
    async run({ user, query }) {
      const who = await whoFor(user);
      const found = await findFiles(who.personId, String(query ?? ""), { limit: 5 });
      if (!found.length) return text("Nothing matched that description.");
      return text(found.map((f) =>
        `• ${f.name ?? f.file}  (distance ${Number(f.distance ?? 0).toFixed(3)}` +
        `${f.pending ? ", still being written" : ""})` +
        `${f.walrusBlob ? `\n  walrus: ${f.walrusBlob}` : ""}`).join("\n"));
    },
  },
  {
    name: "get_file",
    description:
      "Read a document's actual contents back. Served from disk when it is still there and " +
      "from Walrus when it is not, so it survives the server losing its volume. Text comes " +
      "back inline; anything binary comes back as a description and its blob id.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "A stable id for this person in your app." },
        query: { type: "string", description: "A description or filename of the document." },
      },
      required: ["user", "query"],
    },
    async run({ user, query }) {
      const who = await whoFor(user);
      const [best] = await findFiles(who.personId, String(query ?? ""), { limit: 1 });
      if (!best) return text("Nothing matched that description.");
      const got = await loadFile(best);
      if (!got) {
        return failed(`Found the memory of "${best.name ?? best.file}" but neither the disk nor ` +
          `Walrus could produce the bytes.`);
      }
      /* Only decode what is actually text. Handing a model a megabyte of
         mangled PDF helps nobody, and the description already in the memory is
         the more useful thing to return. */
      const printable = /\.(txt|md|csv|json|log)$/i.test(got.name ?? "")
        || /^[\s\x20-\x7e]*$/.test(got.bytes.subarray(0, 512).toString("latin1"));
      if (!printable) {
        return text(`"${got.name}" is ${got.bytes.length} bytes of binary, read from ${got.from}.` +
          `${best.walrusBlob ? `\nwalrus: ${best.walrusBlob}` : ""}` +
          `${best.description ? `\n\nWhat it is: ${best.description}` : ""}`);
      }
      const body = got.bytes.toString("utf8");
      return text(`"${got.name}" (${got.bytes.length} bytes, from ${got.from}):\n\n` +
        (body.length > 40_000 ? `${body.slice(0, 40_000)}\n\n[truncated]` : body));
    },
  },
  {
    name: "list_photos",
    description:
      "List the pictures this person has sent, with the description Continuity wrote for each. " +
      "The description is the searchable half: a photo's bytes cannot be a memory, a sentence can.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "A stable id for this person in your app." },
        query: {
          type: "string",
          description: "Optional. Describe a picture to search for instead of listing all.",
        },
      },
      required: ["user"],
    },
    async run({ user, query }) {
      const who = await whoFor(user);
      const q = String(query ?? "").trim();
      const pics = q
        ? await findImages(who.personId, q, { limit: 5 })
        : await listImages(who.personId, { limit: 20 });
      if (!pics?.length) return text(q ? "No picture matched that." : "No pictures stored.");
      return text(pics.map((p) =>
        `• ${p.description ?? p.file}${p.walrusBlob ? `\n  walrus: ${p.walrusBlob}` : ""}`).join("\n"));
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/* What goes over the wire, without the `run` functions. */
const listed = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

/**
 * One JSON-RPC message in, one response out, or null for a notification.
 *
 * Notifications are the part that is easy to get wrong: a message with no `id`
 * must produce no reply at all, and answering one makes a conforming client
 * hang up. Hence the explicit null rather than an empty object.
 */
export async function dispatch(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;

  const ok = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const err = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "continuity", version: "0.1.0" },
        instructions:
          "Continuity remembers a person across every app that shares this memory. Call `recall` " +
          "before answering anything personal. Call `remember` for facts that will still be true " +
          "next month. An empty recall means nothing matched, never that their memory is broken.",
      });

    /* Both spellings exist in the wild. Neither wants an answer. */
    case "notifications/initialized":
    case "initialized":
      return null;

    case "ping":
      return ok({});

    case "tools/list":
      return ok({ tools: listed });

    case "tools/call": {
      const tool = byName.get(params?.name);
      if (!tool) return err(-32602, `No tool named ${params?.name}`);
      try {
        return ok(await tool.run(params?.arguments ?? {}));
      } catch (e) {
        /* A tool that fails reports it inside the result, so the calling model
           sees the reason and can say something useful, rather than the call
           itself erroring and the agent only learning that something broke. */
        return ok(failed(e.message));
      }
    }

    default:
      return err(-32601, `Unknown method: ${method}`);
  }
}

/* ── stdio ──────────────────────────────────────────────────────────────── */

/**
 * Line-delimited JSON on stdin and stdout, which is what a local client spawns.
 *
 * Nothing may ever be written to stdout except responses: a stray console.log
 * is parsed as a protocol message and kills the session. Logging goes to
 * stderr, which clients show in their own logs.
 */
function serveStdio() {
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buffered += chunk;
    /* Messages arrive split across chunks and several can land in one, so the
       buffer is drained a line at a time and the trailing partial is kept. */
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let out;
      try {
        out = await dispatch(JSON.parse(trimmed));
      } catch (e) {
        console.error("[mcp] bad message:", e.message);
        out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
      }
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  console.error("[mcp] continuity listening on stdio");
}

/* Only when run directly, so importing this for the HTTP route or a test does
   not quietly take over stdin. */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) serveStdio();

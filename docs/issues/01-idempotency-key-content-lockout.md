# Issue 1 — file as a new issue

**Title:**
`idempotencyKey` reused with different content is a permanent, undocumented lockout — the key keeps working for the original text and rejects every new text forever

**Labels:** bug

---

### Surface

TypeScript SDK (@mysten-incubation/memwal)

### Network

Mainnet (relayer.memory.walrus.xyz)

### Package version

`@mysten-incubation/memwal` 0.1.7; signature and JSDoc re-checked against 0.1.8 (latest on npm) and unchanged. Relayer `https://relayer.memory.walrus.xyz`: `relayerVersion 0.1.0`, `apiVersion 1.0.0`, build `79f241ec5e8f93b3e7a219877d36208979c51621`, `mode: production`, `write_ready: true`. Observed 2026-09-30.

### What happened?

Presenting an `idempotencyKey` that was already used, together with **different** text, returns:

```
409 {"error":"idempotency_key was already used for a request with different content"}
```

The rejection is correct in isolation. What makes it a trap is its shape:

- **It does not expire.** No TTL is documented. The key was still rejecting 95 seconds after first use in one controlled run, and a second key seeded at 08:59:43 UTC was still rejecting at 09:03:57 UTC — and indefinitely in production for us, below. We have not found an interval at which a key frees.
- **The key is not dead — it is frozen.** Replaying the *original* text under the same key still succeeds and returns the original `blob_id`. So the key keeps behaving like a healthy idempotent key, right up until the payload changes by one character, at which point that key can never carry a new write again.
- **Nothing documents the constraint where a caller would read it.** `idempotencyKey?: string` appears three times in `memwal.d.ts` — on `rememberAsync`, `rememberAndWait` and `remember` — with no JSDoc on the option at all, in both 0.1.7 and 0.1.8.

The SDK does know about the content binding internally. The JSDoc on the **private** `pendingRememberKeys` field says:

```
Keep a generated idempotency key while a remember request has no
acknowledged response. If the transport times out after the server
accepted the write, the caller's next identical attempt reuses the key
and collapses onto the original paid job.
```

"the caller's next **identical** attempt" is the only acknowledgement anywhere in the type definitions that the key is bound to its content — and it sits on a private field, describing internal retry bookkeeping, where no consumer of the SDK will ever read it. The public option that exposes the same mechanism says nothing.

The natural way to pick a key is something stable and meaningful: `user:<id>`, `session:<id>`, `fact:<slug>`. That is exactly the choice the failure punishes. Any payload containing something volatile — a `createdAt`, a display name, a counter, a re-worded sentence — poisons its key on the first retry with updated content.

### Why it matters

We lost writes for a live Telegram account this way while building a chatbot on Walrus Memory. The account's key had been bound to an earlier version of its profile text. Every later profile write returned 409 and the outbox dropped it. The only user-visible symptom was silence: the bot stopped learning anything new about that person and never said why.

That is the same failure family as #966 and #1001, but a different mechanism:

- **#966** — a *wedged job* resolves the same key to a dead job and returns 504 forever. Same text, broken job.
- **#1001** — Python keeps its generated key after a *terminal failure*, so retrying the same text resolves to the failed job.
- **This report** — the job succeeded, the key is healthy, and it is *changed content* that is refused, permanently.

`#1049` (read-only receipt lookup by key) would help a caller diagnose this after the fact, but not avoid it.

### Steps to reproduce

Save as `idempotency-lockout.mjs` and run with `MEMWAL_PRIVATE_KEY` / `MEMWAL_ACCOUNT_ID` set.

```js
import { MemWal } from "@mysten-incubation/memwal";

const mw = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY,
  accountId: process.env.MEMWAL_ACCOUNT_ID,
});
const ns = `repro-${Date.now()}`;
const key = `repro-key-${Date.now()}`;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const write = async (label, text) => {
  try {
    const r = await mw.rememberAndWait(text, ns, { idempotencyKey: key, timeoutMs: 180_000 });
    console.log(now(), label, "ok blob:", r.blob_id);
  } catch (e) {
    console.log(now(), label, `${e.status}:`, e.message.slice(0, 120));
  }
};

await write("original            ", "first content under this key");
await write("changed             ", "DIFFERENT content under the same key");
await sleep(30_000);
await write("changed, +30s       ", "DIFFERENT content under the same key");
await sleep(60_000);
await write("changed, +90s       ", "DIFFERENT content under the same key");
await write("original, replayed  ", "first content under this key");
```

### Actual

```
2026-09-30T08:56:09.825Z original             ok blob: rH-jsDOacKBnawcwEaNjLtGl2GyMhvJ9xq8AerlLHjA
2026-09-30T08:56:10.350Z changed              409: Walrus Memory server error (409): {"error":"idempotency_key was already used for a request with different content"}
2026-09-30T08:56:41.282Z changed, +30s        409: Walrus Memory server error (409): {"error":"idempotency_key was already used for a request with different content"}
2026-09-30T08:57:42.658Z changed, +90s        409: Walrus Memory server error (409): {"error":"idempotency_key was already used for a request with different content"}
2026-09-30T08:57:45.246Z original, replayed   ok blob: rH-jsDOacKBnawcwEaNjLtGl2GyMhvJ9xq8AerlLHjA
```

The last two lines are the point: the key is live and idempotent for the text it was bound to, and permanently closed to any other text.

### Expected

Any one of these would have saved us the outage:

1. **Document it.** A JSDoc line on `idempotencyKey` saying the key is bound to the content hash of its first accepted request, that the binding does not expire, and that reusing it with different text is a terminal 409.
2. **Scope the binding to a TTL** (the idempotency window most APIs use — minutes to 24h), so a stale key eventually frees rather than being consumed for the lifetime of the account.
3. **Make the error recoverable.** Return a machine-readable code (e.g. `idempotency_key_content_mismatch`) plus the bound `blob_id`, so a caller can tell this apart from a transient 4xx and decide between replaying the original and minting a new key. Right now the only discriminator is matching on English error prose.

### Workaround

Bind the key to a hash of its own content, which makes key and payload consistent by construction — identical writes dedupe, changed writes get a fresh key:

```js
const key = `${logicalKey}:${sha256(text).slice(0, 12)}`;
```

This works, but it means the caller can never use a stable key to mean "this one logical record," which is the thing a stable key is for.

### Checks

- [x] I searched existing issues and this is not a duplicate (nearest: #966, #1001, #932, #1049 — different mechanisms, compared above).
- [x] This report contains no private keys, mnemonics, or other secrets.

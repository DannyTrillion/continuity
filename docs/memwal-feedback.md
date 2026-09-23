# MemWal feedback from building this bot

Found while building a multi-surface chatbot on `@mysten-incubation/memwal@0.1.7`
against the mainnet relayer (`relayer.memory.walrus.xyz`, apiVersion 1.0.0,
relayerVersion 0.1.0).

---

## Bug 1 — recall intermittently returns an empty result set

**Severity: high.** This is the one that matters. For a memory product it is
close to existential, and it hides itself completely.

The same `recall()` call, against the same namespace, with the same query,
sometimes returns `total: 0, results: []` — and sometimes returns the matches.
Nothing distinguishes the two responses. There is no error, no flag, no
`dropped_count`.

### Reproduction

Namespace `ws8::person::199d6d8a-…` holds 13 memories. Fourteen identical calls,
800 ms apart:

```js
for (let i = 0; i < 14; i++) {
  const r = await memwal.recall({ query: "publisher 403", namespace: NS, limit: 5 });
  process.stdout.write(r.results.length + " ");
}
// 5 5 5 5 0 0 5 5 0 0 0 0 5 5      → empty on 6 of 14
```

Runs are not independent — the zeros arrive in clusters, which suggests a
window of bad state (a replica, a cache, an index lease) rather than a per-query
dice roll.

### Why it matters

An empty recall is indistinguishable from a namespace that genuinely has
nothing in it. That is the *expected* response for a first-time user, so no
caller can detect the failure: a memory-backed chatbot simply greets a returning
user as a stranger, at random, roughly 40% of the time. Nothing logs an error.
The bug is invisible from the outside and destroys the product's only promise.

This compounds with the absence of a no-match signal (previously raised as
MemWal #741): callers cannot tell "nothing stored" from "lookup failed", so
there is no way to build a correct client on top of the current contract.

### What it actually cost us

Not a degraded answer — a user's entire history.

Identity here is a record in a key-like namespace (`ws8::id::web::<account>`).
On a cold start the bot reads it to learn who you are. One of those reads came
back empty five times running, so the bot concluded it had never met this
account and minted a **second** person for it. Because append-only storage means
"current value" is the newest record, every later read returned the new, empty
person, and the four memories under the original were orphaned permanently:

```
ws8::id::web::web-proof-2 →
  d083f353-…   (minted by the false empty — no memories)
  fcc93702-…   (the real one — 4 memories, now unreachable)
```

Nothing errored. The user would simply have been greeted as a stranger forever.

We now defend against this in two ways: identity reads retry far harder than
ordinary recalls (an empty answer there is indistinguishable from "new user",
and acting on a false one is unrecoverable), and duplicate identity records are
*healed* rather than resolved newest-wins — every person id ever recorded for an
account is folded into the namespace union, so a split account knits itself back
together. Both are workarounds for the flake, not fixes.

### Suggested fix

Fix the flake, but also make it detectable: distinguish "no matches" from "search
did not run" in the response. Even a boolean would let callers retry honestly
instead of silently serving amnesia.

### Workaround in this codebase

`recall()` in [`src/core/memory.mjs`](../src/core/memory.mjs) retries on empty —
four attempts with exponential backoff (200/400/800/1600 ms). That took the
observed empty rate from 6/14 to **0/16**. Retrying on empty is only acceptable
because a genuinely empty namespace is cheap to re-query; it should not be the
application's job.

---

## Bug 2 — `rememberAndWait` reports failure on writes that succeed

**Severity: medium-high.** Causes duplicate memories and double spend.

`rememberAndWait(text, namespace)` polls with a 60 000 ms default and throws
`504 remember job timed out`. On mainnet, jobs routinely exceed 60 s **and then
complete normally**.

```js
await memwal.rememberAndWait("the project codename is Halibut.", "ws8::test::smoke");
// throws: Error: remember job timed out after 60000ms (job_id=7b213135-…)

await memwal.getRememberStatus("7b213135-f4ff-4dd4-862e-4fa084607ce3");
// { status: "done", blob_id: "1orLRyP-9HQB95NSyxHmC92QdZnpUW6rbI1MGgRTDic", … }
```

Observed round trips ranged from ~34 s to well over 90 s for a single small fact.

A caller that reads the throw as failure and retries writes the same fact twice.
Both are real blobs, both are paid for, and both return on every later recall —
we saw a retried fact come back as two hits at distance 0.450 and 0.458, with
nothing marking one as a duplicate.

**Suggested fix:** raise the default past the observed p99; or throw a distinct
`pending` error so "not yet" is not shaped like "failed"; or apply
`idempotencyKey` automatically inside `rememberAndWait`.

**Workaround:** `rememberFact()` waits 180 s and, on timeout, returns
`{ pending: true, jobId }` for later settlement via `getRememberStatus` — it
never re-sends the text.

---

## Bug 3 — a reused idempotency key is a permanent lockout

**Severity: medium.** Correct server behaviour, but the failure is terminal and
undocumented.

Writing with an `idempotencyKey` that was already used with *different* content
returns:

```
409 {"error":"idempotency_key was already used for a request with different content"}
```

That is reasonable in isolation. What makes it a trap is that it never expires.
A caller using a natural stable key (`user:<id>`) whose payload contains
anything volatile — a `createdAt`, a display name, a counter — poisons that key
permanently on the first retry. Every subsequent write under it fails forever.
We locked out a live Telegram account this way and the only symptom was silence.

**Suggested fix:** document the constraint prominently, and consider scoping the
key's uniqueness to a TTL so a stale key eventually frees.

**Workaround:** bind the key to a hash of its own content
(`${key}:${sha256(text).slice(0,12)}`), which makes key and payload consistent
by construction — identical writes dedupe, changed writes get a fresh key.

---

## Reliability — transient 5xx on `analyze`

Intermittent `500 Internal server error` from `analyzeAndWait` under normal load
(e.g. traceId `ec68f0fd-4443-4bda-a147-3f938f61eabb`), alongside occasional
`Upstream Unavailable: Memory encryption backend is unavailable` and bare
`fetch failed`. All cleared on retry within seconds; `health()` reported
`status: ok, write_ready: true` throughout, including while writes were failing.

Two asks: have `health()` reflect degraded write capability, and note in the
docs that `analyze`/`remember` need client-side retry. A write path that silently
drops a memory on a hiccup is a bad default for a memory product — the reply has
already been sent to the user, so nothing surfaces the loss.

---

## Minor — client sends malformed bodies instead of validating

`rememberAndWait` is positional (`text, namespace`). Passing the object form
that `recall()` accepts (`{ text, namespace }`) is not caught client-side; it is
serialised into the request and the server answers:

```
422 Failed to deserialize the JSON body into the target type:
text: invalid type: map, expected a string at line 1 column 8
```

TypeScript users are protected; JavaScript users get a deserialiser error that
never mentions the argument shape. A `typeof text !== "string"` guard would fix
it. `recall()` accepting both object and positional forms while `remember*` does
not is what makes this easy to hit.

---

## Credit where due

Two things in 0.1.7 solved real problems for us and deserve saying:

- **`analyze()`** doing extraction server-side in the TEE is the right shape. One
  support message became four clean facts with no model tokens of our own spent
  and no raw conversation shipped to a third-party provider.
- **`sort: "recent"`** is exactly the primitive append-only storage needs, and the
  doc comment explaining *why* `scoringWeights` cannot substitute for it — weights
  re-rank the returned window, they do not widen it — saved us from shipping a
  subtly broken newest-wins read. More comments like that one, please.

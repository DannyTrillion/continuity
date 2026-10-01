# Comment to post on MemWal #1036

> "[Relayer] An all-dropped recall returns 200 with results: [], total: 0: indistinguishable from 'no memories'"
> https://github.com/MystenLabs/MemWal/issues/1036

**Do not file this as a new issue.** It is the same symptom we hit, and #1036 has the better diagnosis. What we can add is an independent reproduction, and the cost of the failure when the empty lands on an *identity* lookup rather than a profile one.

---

Independent reproduction of the symptom, on SDK 0.1.7 against the same mainnet relayer, while building a multi-surface chatbot on Walrus Memory.

**Fourteen identical calls, 800 ms apart, against a namespace holding 13 memories:**

```js
for (let i = 0; i < 14; i++) {
  const r = await memwal.recall({ query: "publisher 403", namespace: NS, limit: 5 });
  process.stdout.write(r.results.length + " ");
}
// 5 5 5 5 0 0 5 5 0 0 0 0 5 5      → empty on 6 of 14
```

The zeros arrive in clusters rather than independently, which matches your "window of bad state" reading — a replica, a cache or an index lease, rather than a per-query dice roll.

One caveat on attribution: we were not logging `dropped_count` when we captured this, so we cannot confirm ours was the all-dropped path you identified. Re-running probes against the same relayer on 2026-09-30 (build `79f241ec5e8f93b3e7a219877d36208979c51621`), we saw `dropped_count: 0` throughout and no empties, consistent with your 09-24 and 09-27 re-runs.

**What it cost, which is the part we would push on.**

Your report describes the chatbot answering as if it had never met the user. That is recoverable — the next recall returns the memories and the answer is merely bad once. It is unrecoverable when the empty lands on an identity read.

We store identity as a record in a key-like namespace (`ws8::id::web::<account>`). On a cold start the bot reads it to learn which person id this account maps to. One of those reads came back empty five times running, so the bot concluded it had never seen the account and minted a **second** person id for it. Because storage is append-only and "current value" means the newest record, every later read returned the new, empty person, and the memories under the original became unreachable:

```
ws8::id::web::web-proof-2 →
  d083f353-…   (minted by the false empty — no memories)
  fcc93702-…   (the real one — 4 memories, now orphaned)
```

Nothing errored, and nothing could have: an empty recall is the *correct* response for an account that genuinely is new, so the caller has no signal to branch on. That user would have been greeted as a stranger permanently.

So the severity depends on what the caller does with the empty. Any application using recall to answer "have I seen this key before?" turns a transient empty into permanent data loss, and that pattern is the natural one for identity, session resumption and dedupe. Recovering from it needs a separate reconciliation path, because the append-only newest-wins read will keep returning the wrong answer afterwards.

**One diagnostic worth recording.** Retrying on empty with exponential backoff — four attempts spanning roughly 3 seconds — took the observed rate from **6/14 to 0/16**. The flake clears well inside a single request budget, which supports your transient-window reading rather than a persistently bad replica. We retry only namespaces already known to hold data; retrying genuinely empty ones is wasted load, and enough of that contributed to us hitting the account rate limit.

Retrying is a workaround, not a fix, and it only covers the caller that gets to retry. Anything that acts on a false empty before retrying — minting an identity, starting a fresh session, deduping against an empty set — has already written the damage durably.

**On the proposed fix:** `degraded: true` or a typed error would let us drop both workarounds. We would add one request — that the signal be present whenever the search did not run to completion, not only when `dropped_count > 0`. From a caller's side, "every match was dropped" and "the index lease was stale so nothing was searched" need the same defensive branch, and today neither is distinguishable from an honestly empty namespace.

Related: #741 (no no-match signal) is the same gap from the other direction — callers cannot tell "nothing stored" from "lookup failed", and a correct client cannot be built on the current contract without one of the two.

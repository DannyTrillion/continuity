# Comment to post on MemWal #686

> "`remember()` rate limit (30 weighted-requests/min) is completely undocumented"
> https://github.com/MystenLabs/MemWal/issues/686

**Do not file this as a new issue.** #686 owns the documentation gap. This adds measured values for a second limit layer it does not mention, a number that disagrees with the one in the title, and the error-shape problem that makes correct backoff impossible.

---

Measured against mainnet (`relayer.memory.walrus.xyz`, `relayerVersion 0.1.0`) while building a chatbot on Walrus Memory. **There are at least two layers, and only one of them is discussed here:**

| layer | limit observed | `retry_after_seconds` |
|---|---|---|
| `account_sustained` | 1000 weighted-requests/hour | 300 |
| `delegate_key` | 60 weighted-requests/minute | 60 |

Two notes on that table.

First, the per-minute figure we observed on `delegate_key` is **60**, not the 30 in this issue's title. Either it has changed since August, or it varies by account or key type. That ambiguity is itself the argument for documenting it: two developers reading the same tracker now have two different numbers and no way to tell which applies to them.

Second, `account_sustained` appears to be undocumented everywhere, including here. An hourly ceiling is the one you can actually pace against, and it is the one that silently governs any sustained workload. A chatbot spends several weighted requests per conversational turn — identity read, personal recall, knowledge-base recall, then the writes — so 1000/hour is a real ceiling rather than a theoretical one. Seeding a few hundred knowledge-base facts and capturing a dozen conversations reached it inside an hour.

**The part that makes it unhandleable: the 429 does not arrive as a 429.**

```
remember job failed: Internal Error: seal encrypt failed:
seal/encrypt failed during read_account_identity: RpcError: Too Many Requests
```

That is HTTP **500** at the SDK boundary, with the real cause buried three layers down in English prose, and `retry_after_seconds` absent entirely. A caller cannot back off correctly from it: `err.status` reads 500, so ordinary retry logic treats it as a transient server error and retries immediately — into the wall, spending more budget, extending the lockout. Honouring the relayer's own stated wait is impossible because the field does not survive the re-wrap.

The symptoms *before* the limit finally surfaced as an explicit 429 were all indirect: writes that never landed, recalls that returned empty, jobs that timed out. Every one of those looks like ordinary relayer instability, so we spent real time debugging the wrong thing. A rate limit that presents as flakiness is worse than one that presents as a rate limit.

**Three asks, in the order they would have helped us:**

1. **Propagate the 429 intact**, with `retry_after_seconds`, rather than re-wrapping it as a 500 through the seal-encrypt path. This is the one that turns an unhandleable failure into a handleable one, and it is a bug rather than a docs gap. (#999 and #1002 look adjacent to where this happens; #767, closed, recorded `retry_after_seconds` being ignored on the bulk path.)
2. **Document both layers** next to the methods that consume them — not just `remember()`, since recall and bulk draw on the same budget.
3. **Surface the weighting.** "Weighted request" appears in the error messages but nowhere in the SDK, so a caller cannot compute its own budget. What does a recall cost? A bulk write of 50 items — one, or fifty? Without that, pacing is guesswork, and #686's point that `rememberBulk()` is the correct pattern for multiple writes can't be evaluated against a number.

**One note in the SDK's favour:** `err.retryAfterSeconds` *is* populated on responses that arrive as genuine 429s — that is where the 300 s and 60 s in the table above came from — and backing off on it works. The gap is entirely in the re-wrapped path: the same information exists upstream and is gone by the time the caller sees a 500.

# Issue 3 — file as a new issue

**Title:**
`[Bug] A maxDistance filter that drops every result returns `{results: [], total: 0}` — byte-identical to an empty namespace, in both SDKs

**Labels:** bug

---

### Surface

TypeScript SDK (@mysten-incubation/memwal)

### Network

Mainnet (relayer.memory.walrus.xyz)

### Package version

`@mysten-incubation/memwal` 0.1.7 (TypeScript) and `memwal` 0.1.11 (Python) — both reproduce. Relayer `relayerVersion 0.1.0`, `apiVersion 1.0.0`, build `f58104334b9d`, `mode: production`. Observed 2026-10-01.

### What happened?

`maxDistance` (TS) / `max_distance` (Python) is applied client-side, after the relayer has returned its matches. Both SDKs then **overwrite `total` with the post-filter count**. When the filter removes everything, the caller gets:

```json
{ "results": [], "total": 0 }
```

A recall against a genuinely empty namespace returns:

```json
{ "results": [], "total": 0 }
```

These are byte-identical. The fact that the relayer matched eight memories, and that the caller's own threshold is what discarded them, is gone from the response.

TypeScript, `dist/memwal.js`:

```js
if (typeof options.maxDistance === "number") {
    const filtered = result.results.filter((memory) => memory.distance < options.maxDistance);
    processed = {
        ...processed,
        results: filtered,
        total: filtered.length,      // <-- server's total discarded
    };
}
```

Python, `client.py`:

```python
if max_distance is not None:
    memories = [m for m in memories if m.distance < max_distance]
    return RecallResult(
        results=memories, total=len(memories), dropped_count=dropped
    )                                 # <-- server's total discarded
```

Note the Python path also makes `total` mean two different things depending on an unrelated argument: without `max_distance` it is `data.get("total", …)`, the relayer's count; with it, the post-filter length.

### Why it matters

This is the exact ambiguity #1036 is open about — "an empty result is indistinguishable from no memories" — except here the SDK manufactures it deterministically, on healthy data, with no relayer fault involved.

The consequence is the same one #1036 describes. An application that checks `results.length` or `total` to answer "have I seen this user before?" gets told no. A memory-backed chatbot greets a returning user as a stranger. We lost a user's entire history to that read in a different code path, so this is not hypothetical: the pattern of using recall as an existence check is the natural one for identity, session resumption and dedupe.

There's an irony worth naming. #968 was closed by adding this cutoff, because unrelated queries were returning filler at distance ≥0.9 into LLM prompts. The cutoff does fix that. But as implemented it destroys the one signal that distinguishes "I have memories, none of them are relevant enough" from "I have nothing about you" — and those two call for completely different behaviour from a caller. #741 is still open asking for precisely this no-match signal.

So a developer who follows the advice in #968, sets a threshold, and gets back `total: 0`, has no way to know which situation they're in.

### Steps to reproduce

**TypeScript:**

```js
import { MemWal } from "@mysten-incubation/memwal";
const mw = MemWal.create({ key: process.env.MEMWAL_PRIVATE_KEY, accountId: process.env.MEMWAL_ACCOUNT_ID });

const NS = "<a namespace holding several memories>";
const query = "how does memory work";
const show = (l, r) => console.log(l.padEnd(34), JSON.stringify({ n: r.results.length, total: r.total, dropped: r.dropped_count }));

show("no maxDistance",            await mw.recall({ query, namespace: NS, limit: 8 }));
show("maxDistance 2.0 (none)",    await mw.recall({ query, namespace: NS, limit: 8, maxDistance: 2.0 }));
show("maxDistance 0.0001 (all)",  await mw.recall({ query, namespace: NS, limit: 8, maxDistance: 0.0001 }));
show("genuinely empty namespace", await mw.recall({ query, namespace: "empty-" + Date.now(), limit: 8 }));
```

**Python** (same shape, `memwal` 0.1.11):

```python
r = await mw.recall(Q, limit=8, namespace=NS, max_distance=0.0001)
print(len(r.results), r.total, r.dropped_count)   # 0 0 0
```

### Expected

The response should still say that matches existed and were filtered. Any of these would do:

1. **Keep the relayer's `total`** and let `results.length` carry the post-filter count. That alone makes the two cases distinguishable, and it matches what `total` means on every other path.
2. **Add a `filtered_count`** (or reuse the `meta` object that `maxTokens` already populates with `truncated`) so the caller can see the threshold acted.
3. At minimum, **document** that `total` is post-filter when `maxDistance` is set, and that an empty result under a threshold does not mean an empty namespace.

Option 1 is the one we'd want. `maxTokens` already sets `meta.truncated` for exactly this reason — a caller can tell a budget-trimmed recall from an empty one. The distance filter should not be less transparent than the token filter.

### Actual

Live against mainnet, 2026-10-01, namespace holding 8 matching memories:

```
no maxDistance                     results=8 total=8 dropped=0
maxDistance 2.0 (filters none)     results=8 total=8 dropped=0
maxDistance 0.0001 (filters all)   {"results":[],"total":0}
genuinely empty namespace          {"results":[],"total":0}
```

Python 0.1.11, same namespace and query:

```
no max_distance   : results=8 total=8 dropped=0
max_distance=2.0  : results=8 total=8 dropped=0
max_distance=tiny : results=0 total=0 dropped=0
```

### Logs or error text

```shell
(no error — the whole point is that nothing is reported)
```

### Checks

- [x] I searched existing issues and this is not a duplicate (nearest: #1036 — same ambiguity, relayer-caused; #741 — asks for the missing no-match signal; #968, closed — added this cutoff; #976 — distance validation. None covers `total` being overwritten by the client-side filter).
- [x] This report contains no private keys, mnemonics, or other secrets.

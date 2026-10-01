# Issue 5 — file as a new issue

**Title:**
`[Bug] recall() does not validate `maxTokens`: a negative budget silently drops every result, a non-numeric one silently disables budgeting

**Labels:** bug

---

### Surface

TypeScript SDK (@mysten-incubation/memwal)

### Network

Mainnet (relayer.memory.walrus.xyz)

### Package version

`@mysten-incubation/memwal` 0.1.7; code paths re-checked against 0.1.8 (latest on npm) and unchanged. Relayer `relayerVersion 0.1.0`, `apiVersion 1.0.0`, build `f58104334b9d`. Observed 2026-10-01.

### What happened?

`recall({ maxTokens })` accepts any value without validation, and four kinds of invalid input produce three different silent behaviours. Measured against a namespace holding 8 matching memories:

| `maxTokens` | results | total | `meta` |
|---|---|---|---|
| *(omitted)* | 8 | 8 | `undefined` |
| `0` | 0 | 0 | `{tokenEstimate: 0, truncated: true}` |
| `-5` | **0** | **0** | `{tokenEstimate: 0, truncated: true}` |
| `NaN` | 8 | 8 | `{tokenEstimate: 318, truncated: false}` |
| `Infinity` | 8 | 8 | `{tokenEstimate: 318, truncated: false}` |
| `"400"` *(string)* | **8** | **8** | **`undefined`** |
| `null` | 8 | 8 | `undefined` |

Two of those rows are the problem.

**A negative budget silently discards everything.** `applyTokenBudget` treats any non-positive number as a real budget:

```js
// tokens.js
if (maxTokens <= 0) {
    return { results: [], meta: { tokenEstimate: 0, truncated: originalCount > 0 } };
}
```

and `recall()` then overwrites `total` with the trimmed length:

```js
// memwal.js
if (typeof options.maxTokens === "number") {
    const { results: budgeted, meta } = applyTokenBudget(...);
    processed = { ...processed, results: budgeted, total: budgeted.length, meta };
}
```

So `maxTokens: -5` yields `{ results: [], total: 0 }`. That is byte-identical to a recall against an empty namespace except for the `meta` object, which a caller checking `results.length` or `total` will not be looking at.

**A non-numeric budget silently disables budgeting.** The guard is `typeof options.maxTokens === "number"`, so `"400"` from an environment variable or a JSON config file doesn't throw, doesn't warn, and doesn't budget. The caller believes they capped the payload at 400 tokens and receives the full unbudgeted result with no `meta` at all. The failure surfaces later, as an overflowing model context, far from its cause.

### Why it matters

Neither input is exotic. Both arise from the two most natural ways to produce the value:

```js
// 1. computed budget — underflows to negative whenever the prompt is already large
const budget = MODEL_CONTEXT - promptTokens - reserveForAnswer;
const hits = await memwal.recall({ query, namespace, maxTokens: budget });

// 2. configured budget — a string unless explicitly coerced
const hits = await memwal.recall({ query, namespace, maxTokens: process.env.RECALL_MAX_TOKENS });
```

Case 1 is the dangerous one. An agent whose prompt grew past its own context limit stops recalling anything, and the empty result looks exactly like a user it has never met. That is the same silent-amnesia failure #1036 is open about and that #1066 reports for the `maxDistance` filter — a third client-side route to the same indistinguishable empty.

Case 2 quietly removes a safety limit the caller thinks is active.

### Note on the existing contract

`tokens.d.ts` already states the principle:

> A non-finite budget (NaN / Infinity) is treated as "no budget": the payload is returned unchanged with `truncated: false` — **a malformed budget must never claim it truncated.**

NaN and Infinity honour that, and the table above confirms it. A negative budget is equally malformed and does the opposite: it drops the entire payload *and* reports `truncated: true`. The intent looks right; the check is just `Number.isFinite`, which `-5` passes.

### Steps to reproduce

```js
import { MemWal } from "@mysten-incubation/memwal";
const mw = MemWal.create({ key: process.env.MEMWAL_PRIVATE_KEY, accountId: process.env.MEMWAL_ACCOUNT_ID });

const NS = "<a namespace holding several memories>";
const query = "how does memory work";

const run = async (label, maxTokens) => {
  const r = await mw.recall({ query, namespace: NS, limit: 8, maxTokens });
  console.log(label.padEnd(24), `results=${r.results.length} total=${r.total} meta=${JSON.stringify(r.meta)}`);
};

await run("omitted",   undefined);
await run("-5",        -5);          // expect: rejected, or treated as no budget
await run("NaN",       NaN);         // documented: unchanged, truncated:false
await run("'400'",     "400");       // expect: rejected, or coerced
```

### Expected

Validate the budget once, in `recall()`, and treat the invalid cases consistently. Either of these is fine, as long as it's one of them:

1. **Throw** a `TypeError`/`RangeError` for a negative or non-numeric `maxTokens`. A budget the caller cannot honour is a programming error, and failing loudly at the call site beats an empty recall surfacing as amnesia three layers away.
2. **Treat anything malformed as "no budget"** — negative included — matching the NaN/Infinity path and the stated rule that a malformed budget must never claim it truncated. If that route is taken, a numeric-string budget should either be coerced or rejected, not silently ignored.

A genuine `maxTokens: 0` is the one case worth keeping as-is: zero is a coherent request for an empty payload, and `truncated: true` is honest there.

Separately, and regardless of which option is chosen: `total` should not be overwritten with the post-budget length, for the same reason given in #1066. Keeping the relayer's `total` is what lets a caller tell "nothing matched" from "my own budget removed everything."

### Actual

Live against mainnet, 2026-10-01, namespace holding 8 matching memories:

```
maxTokens undefined        results= 8 total= 8 meta=undefined
maxTokens 0                results= 0 total= 0 meta={"tokenEstimate":0,"truncated":true}
maxTokens -5               results= 0 total= 0 meta={"tokenEstimate":0,"truncated":true}
maxTokens NaN              results= 8 total= 8 meta={"tokenEstimate":318,"truncated":false}
maxTokens Infinity         results= 8 total= 8 meta={"tokenEstimate":318,"truncated":false}
maxTokens 1.5              results= 0 total= 0 meta={"tokenEstimate":0,"truncated":true}
maxTokens '400' (string)   results= 8 total= 8 meta=undefined
maxTokens null             results= 8 total= 8 meta=undefined
```

### Logs or error text

```shell
(no error — nothing is reported in either failing case)
```

### Checks

- [x] I searched existing issues and this is not a duplicate. Nearest: #935 (closed) covered a `Math.floor` character-loss bug on *fractional* budgets, not validation of negative or non-numeric input; #592 (closed) added the feature; #528 (closed) concerned the default `limit`. Nothing covers `maxTokens` input validation. #1066 is the sibling `maxDistance` case and is referenced above for the shared `total` behaviour.
- [x] This report contains no private keys, mnemonics, or other secrets.

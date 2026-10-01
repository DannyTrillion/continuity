# MemWal issue drafts — triage

Everything in `docs/memwal-feedback.md` checked against the MystenLabs/MemWal
tracker on **30 Sept 2026** (255 issues read: 101 open, 154 closed).

The headline: the tracker is crowded. Six of our seven findings already have
issues, several filed within the last ten days. Filing those again would be a
duplicate — rejected, and noisy for maintainers who are clearly fielding a lot
of hackathon traffic.

So this splits into **two new issues** and **four comments that add evidence to
existing ones**.

## Filed — 30 Sept 2026

| file | filed as | why it is not a duplicate |
|---|---|---|
| `01-idempotency-key-content-lockout.md` | **[#1057](https://github.com/MystenLabs/MemWal/issues/1057)** — reused `idempotencyKey` + different content = permanent 409; the original text still replays fine | #966 is a *wedged job* (504 loop, same text); #1001 is Python keeping a key after *terminal failure*; #932 (closed) is a concurrency race. None covers content-mismatch lockout on a healthy key. |
| `02-remember-accepts-object-form.md` | **[#1058](https://github.com/MystenLabs/MemWal/issues/1058)** — `rememberAndWait({text, namespace})` is serialised and sent, giving a 422 deserialiser error that never names the argument | #1038 is the mirror problem on `recall()`; #422 is the general structured-errors ask; #582 (closed) is docs. The `remember*` guard itself is unfiled. |

Two more filed on **1 Oct 2026**, after a hunt through the Python SDK (`memwal`
0.1.11), which is where the tracker's recent finds are coming from:

| file | filed as | what |
|---|---|---|
| `07-maxdistance-erases-total.md` | **[#1066](https://github.com/MystenLabs/MemWal/issues/1066)** | A `maxDistance` filter that drops every result returns `{results: [], total: 0}`, byte-identical to an empty namespace. Both SDKs overwrite the server's `total` with the post-filter count, manufacturing the exact ambiguity #1036 is open about. |
| `08-ts-missing-ask.md` | **[#1067](https://github.com/MystenLabs/MemWal/issues/1067)** | The TypeScript SDK has no `ask()` binding. `/api/ask` is advertised in `/health` as `prompt_versions.ask: "ask.v2"`, works in Python 0.1.11, and is not referenced anywhere in the TS dist. |

| `09-maxtokens-unvalidated.md` | **[#1068](https://github.com/MystenLabs/MemWal/issues/1068)** | `recall()` doesn't validate `maxTokens`. A negative budget drops every result and reports `truncated: true`, violating the SDK's own documented rule that a malformed budget must never claim truncation; a non-numeric one silently skips budgeting entirely, because the guard is `typeof === "number"`. |

All five filed by `DannyTrillion` against the repo's `bug.yml` form headings.
Labels come from maintainer triage — outside reporters cannot set them, so all
show as unlabelled, like #742 and #966.

**Only #1057 and #1058 were claimed through the bounty form on 1 Oct. #1066,
#1067 and #1068 were filed afterwards and still need claiming.**

## Checked and found clean (do not re-investigate)

Recorded so the same ground isn't covered twice: `utils.py` crypto helpers; the
`MemWalSync` event-loop wrapper (handles Jupyter and loop-bound httpx clients
correctly); `embed()` (works, 1536 dims — #618 is genuinely fixed); `ask()`
answer grounding (correct); namespace cursor pagination (587 namespaces, zero
duplicates, zero skips); namespaces over 255 bytes (cleanly rejected with a 400,
so #475's truncation claim does not hold on the write path); and the mock's
`max_distance`-before-`limit` ordering, which *looks* divergent from the real
client but is equivalent, because filtering a distance-sorted list is a prefix
operation.

Both were re-verified against the live mainnet relayer on 30 Sept 2026 and both
still reproduce on 0.1.7. Signatures and JSDoc re-checked against **0.1.8**
(latest on npm) and unchanged, so neither is fixed in the current release.

## Posted as comments — 30 Sept 2026

| file | posted on | what it adds |
|---|---|---|
| `03-comment-on-1036-recall-empty.md` | **[#1036](https://github.com/MystenLabs/MemWal/issues/1036#issuecomment-5908073261)** | Independent 6/14 reproduction, plus the severity case #1036 lacks: when the empty lands on an *identity* read it mints a second person id and orphans the history permanently. Retry-on-empty measurement (6/14 → 0/16). |
| `04-comment-on-742-timeout-masks-success.md` | **[#742](https://github.com/MystenLabs/MemWal/issues/742#issuecomment-5908074344)** | Still reproduces on 0.1.7 (filed against 0.0.7), with job id. Quantifies the duplicate cost it predicts: one retried fact returns as two recall hits at distance 0.450 and 0.458, forever. |
| `05-comment-on-691-bulk-failure-as-value.md` | **[#691](https://github.com/MystenLabs/MemWal/issues/691#issuecomment-5908075715)** | Argues *which* contract to standardise on. 190 statements in, 113 landed, nothing threw — a failure delivered as a value is structurally invisible to promise-based retry wrappers. |
| `06-comment-on-686-rate-limits.md` | **[#686](https://github.com/MystenLabs/MemWal/issues/686#issuecomment-5908076826)** | A second undocumented layer (`account_sustained`, 1000/hr), a per-minute figure of 60 that disagrees with the 30 in the title, and the 429-rewrapped-as-500 that discards `retry_after_seconds`. |

The posted versions of 03, 04 and 05 are trimmed: the measured evidence is all
there, but how *we* worked around each bug (identity healing, the outbox, internal
method names) was cut before posting, per "don't want other contestants spying".
The files in this folder are the trimmed versions, so they match what is live.

## Checked and deliberately dropped

- **`analyze` transient 5xx / `health()` reporting ok during write failures** — covered by #709 and #474, both closed. We cannot reproduce on demand, so there is nothing to add.
- **Truncation emptying a recall.** Worth recording because it looked promising and was wrong. We pass `maxTokens: 700` with `truncationStrategy: "high-relevance-only"`, and a small budget does return `results: [], total: 0` — `total` is the post-truncation count, not the match count. But the response also carries `meta: { tokenEstimate: 0, truncated: true }`, which an honestly empty namespace omits entirely, and both fields are fully typed and documented in `types.d.ts`. The two cases *are* distinguishable. Not a bug, and it does not explain our Bug 1 — at `maxTokens: 700` the same query returns 8 of 8.
- **Namespace 12-character truncation (#475, open)** — does not match our experience; 383 namespaces under `ws8::person::<uuid>` and `ws8::id::web::<account>` prefixes stay distinct, which they could not if identifiers truncated to 12 bytes.

## Reproduction environment

All probe output quoted in these drafts came from:

- `@mysten-incubation/memwal` 0.1.7, Node v22.22.2, macOS
- `https://relayer.memory.walrus.xyz` — `relayerVersion 0.1.0`, `apiVersion 1.0.0`,
  build `79f241ec5e8f93b3e7a219877d36208979c51621`, `mode: production`, `write_ready: true`
- 30 Sept 2026, 08:55–09:03 UTC

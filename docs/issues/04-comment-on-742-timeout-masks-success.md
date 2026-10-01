# Comment to post on MemWal #742

> "rememberAndWait masks terminal job state behind a generic timeout — surfaced status would prevent blind retries and duplicate writes"
> https://github.com/MystenLabs/MemWal/issues/742

**Do not file this as a new issue.** #742 already describes it precisely, including the Day 4 reproduction. This adds that it is still present thirteen months later on a current SDK, and quantifies the duplicate-write cost it warns about.

---

Confirming this still reproduces on `@mysten-incubation/memwal` **0.1.7** against mainnet (`relayerVersion 0.1.0`, `apiVersion 1.0.0`). #742 was filed against 0.0.7, so this has survived the 0.0.x → 0.1.x line.

```js
await memwal.rememberAndWait("the project codename is Halibut.", "ws8::test::smoke");
// throws: Error: remember job timed out after 60000ms (job_id=7b213135-…)

await memwal.getRememberStatus("7b213135-f4ff-4dd4-862e-4fa084607ce3");
// { status: "done", blob_id: "1orLRyP-9HQB95NSyxHmC92QdZnpUW6rbI1MGgRTDic", … }
```

The job completed normally. The caller was told it failed.

**On the default.** Single small facts took ~34 s to well over 90 s on mainnet during our build. The default `timeoutMs` is 60 000, which sits inside that distribution rather than above it, so the timeout fires on ordinary healthy writes rather than on pathological ones. Raising the default past the observed p99 would not fix the ambiguity #742 is about, but it would stop the ambiguity being reached on the happy path.

**The duplicate cost, measured.** #742 notes that a caller treating timeout-as-failure creates a permanent duplicate. We hit exactly that before we understood the failure. A fact written twice came back as two separate hits on every later recall, at distance **0.450** and **0.458**, with nothing in the response marking either as a duplicate of the other. Both are real blobs, both were paid for, and both occupy the token budget on every subsequent recall — so one blind retry degrades every future read of that namespace, not just the write.

That interacts badly with #1042 (optional dedupe / collapse identical text in recall results): today there is no server-side collapse, so the duplicate is permanent and visible forever.

**What we ended up building** is precisely the hand-rolled recovery this issue asks to be made unnecessary: wait well past the observed p99, and on timeout return `{ pending: true, jobId }` for settlement later through `getRememberStatus`, never re-sending the text. Confirming a job's outcome before any retry is the thing that prevents the duplicate. It works, but every caller has to invent it independently, and the ones who don't already know that timeout means unknown will write the duplicate instead.

Of the options in #742, the `{ result: "done", blob_id } | { result: "timeout", jobId }` return shape is the one we would have used unchanged — it makes the recovery path one call instead of a polling loop each caller writes for themselves. Applying `idempotencyKey` automatically inside `rememberAndWait` would also close it, though note that a content-bound key has its own permanent-lockout hazard once the payload changes.

Related: #658 and #477 (closed) describe the same unknown-outcome problem from the congestion side; #691 is the bulk counterpart, where the identical condition returns gracefully instead of throwing.

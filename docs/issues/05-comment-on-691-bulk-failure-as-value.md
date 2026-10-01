# Comment to post on MemWal #691

> "waitForRememberJob (single) throws on timeout, while waitForRememberJobs (bulk) gracefully returns for the identical failure condition"
> https://github.com/MystenLabs/MemWal/issues/691

**Do not file this as a new issue.** #691 already identifies the asymmetry and the exact lines. What we can add is field evidence for *which* of the two contracts is the wrong one, and the scale of loss the bulk contract produced for us.

---

This issue frames the divergence as an inconsistency and proposes resolving it either way. We hit the consequence in production, and it argues specifically against standardising on the bulk contract.

**Seeding a knowledge base: 190 statements went in, 113 landed. Nothing threw.**

The 77 that vanished were entries inside `results`, with statuses the caller had to go looking for:

```
failed:  Upstream Unavailable: Memory encryption backend is unavailable
timeout: polling timed out after 300000ms
```

Both causes were transient and cleared on a retry seconds later, so nothing here was unrecoverable — it was only invisible.

**Why the graceful return is the more dangerous half.** Retry logic is written around promises. Every wrapper we had — and every wrapper in every SDK example — is shaped like:

```js
await withRetry("rememberBulk", () => memwal.rememberBulkAndWait(texts, ns));
```

A failure delivered as a value inside a resolved promise is structurally invisible to that. The retry wrapper sees success. The caller sees success. `results.length === texts.length`, which is the obvious thing to assert on, is also true. We only found the loss by inspecting every result entry after the fact, and by then the 40%-data-loss path and the happy path had looked identical for the whole run.

The throw-on-timeout side of the asymmetry, by contrast, fails loudly and gets retried correctly by ordinary code. It is noisier, but nothing disappears.

So we would push for resolving #691 toward **both throwing** — or, if the per-item result shape is worth keeping for partial success (it is), then `rememberBulkAndWait` should reject when *every* item failed, and the JSDoc should state prominently that per-item status must be inspected. A bulk call where nothing landed is not a partial success; it is a failed call wearing the shape of a successful one.

Related and consistent with this: #967 (closed) — a 12-item batch silently landing 0 memories with no per-item failure surfaced under rate limiting — and #439, where three empty `blob_id` values came back with the restore total unchanged. Three separate reporters have now hit "bulk returned normally and nothing was stored," which suggests the contract rather than the conditions.

**What we ended up building:** a wrapper that inspects every result entry and retries the failed ones itself with backoff, because the outer retry wrapper structurally cannot see a failure that arrives as a value. That is the workaround every caller of this API has to write independently, and most will never know they need it.

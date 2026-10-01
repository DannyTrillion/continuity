# Issue 2 — file as a new issue

**Title:**
`remember*()` serialises `recall()`'s object form as `text` instead of rejecting it — JS callers get a server deserialiser error that never names the argument

**Labels:** bug, DX

---

### Surface

TypeScript SDK (@mysten-incubation/memwal)

### Network

Mainnet (relayer.memory.walrus.xyz)

### Package version

`@mysten-incubation/memwal` 0.1.7; signature re-checked against 0.1.8 (latest on npm) and unchanged. Relayer `relayerVersion 0.1.0`, `apiVersion 1.0.0`. Observed 2026-09-30.

### What happened?

`recall()` is deliberately flexible about its arguments. Its JSDoc advertises four shapes:

```js
memwal.recall({ query: "food allergies", limit: 5, namespace: "profile" })
// - recall(query)
// - recall(query, limit)
// - recall(query, limit, namespace)
```

`rememberAndWait()` is positional only — `rememberAndWait(text: string, namespace?: string, opts?)` — and reaching for the object form that the sibling method accepts is an easy mistake to make. The SDK does not catch it. The object is serialised into the request body as `text`, sent, paid for as a weighted request, and the relayer answers:

```
422 Walrus Memory server error (422): Failed to deserialize the JSON body into the
target type: text: invalid type: map, expected a string at line 1 column 8
```

Nothing in that message names the method, the argument, or the expected shape. "invalid type: map, expected a string at line 1 column 8" describes the JSON body the caller never wrote and cannot see.

TypeScript users are protected by the signature. JavaScript users — which the SDK fully supports, and which the quickstart snippets are written in — get a deserialiser error from a Rust backend and no route back to their own typo.

### Steps to reproduce

```js
import { MemWal } from "@mysten-incubation/memwal";

const mw = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY,
  accountId: process.env.MEMWAL_ACCOUNT_ID,
});
const ns = `repro-${Date.now()}`;

try {
  // the shape recall() accepts, handed to rememberAndWait()
  await mw.rememberAndWait({ text: "object form probe", namespace: ns }, ns, { timeoutMs: 60_000 });
} catch (e) {
  console.log(`${e.status}: ${e.message}`);
}
```

### Actual

```
2026-09-30T08:55:24.214Z 422: Walrus Memory server error (422): Failed to deserialize the JSON body into the target type: text: invalid type: map, expected a string at line 1 column 8
```

### Expected

A client-side guard that fails before the request is built, naming the argument:

```js
if (typeof text !== "string") {
  throw new TypeError(
    `remember() expects text as a string, received ${typeof text}. ` +
    `Did you mean remember(text, namespace)? Unlike recall(), remember* does not take an options object.`
  );
}
```

A `typeof text !== "string"` check on the three `remember*` entry points would cover it. Two things follow from having it:

- The caller learns what they got wrong, rather than reading a deserialiser trace.
- The request is never sent, so a typo stops costing a weighted request against the account's budget.

Alternatively, accept the object form on `remember*` the way `recall()` does, so the two halves of the API stop disagreeing about their calling convention. Either fix is fine; the current state — one method tolerant, its sibling silently forwarding malformed JSON — is the part that catches people.

### Related

- #422 (expose structured error types) — this is one concrete instance; a typed `InvalidArgumentError` would be the structured-errors answer to it.
- #1038 (`recall(query, {...}, "namespace")` ignores the namespace argument) — the mirror-image problem on the other method, which suggests argument handling across the two families is worth one pass rather than two fixes.
- #582 (closed) — quickstart snippets teaching the deprecated positional `recall()` form; the same divergence in the docs.

### Checks

- [x] I searched existing issues and this is not a duplicate (nearest: #422, #1038, #582 — noted above).
- [x] This report contains no private keys, mnemonics, or other secrets.

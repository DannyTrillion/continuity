# Issue 4 — file as a new issue

**Title:**
`[Bug] TypeScript SDK has no `ask()` binding — `/api/ask` is advertised by `/health` and implemented in the Python SDK, but unreachable from TS

**Labels:** bug, api-parity

---

### Surface

TypeScript SDK (@mysten-incubation/memwal)

### Network

Mainnet (relayer.memory.walrus.xyz)

### Package version

`@mysten-incubation/memwal` 0.1.7 and 0.1.8 (latest on npm) — neither has it. Compared against `memwal` 0.1.11 (Python), which does. Relayer `relayerVersion 0.1.0`, `apiVersion 1.0.0`, build `f58104334b9d`. Observed 2026-10-01.

### What happened?

The relayer serves `POST /api/ask`: a server-side retrieval-and-answer endpoint that recalls from a namespace and returns a grounded natural-language answer plus the memories it used. It is not an experiment. The relayer advertises it in its own public health payload, with a prompt version:

```json
"prompt_versions": { "extract": "extract.v6", "ask": "ask.v2" }
```

The **Python** SDK exposes it as `ask()` on both the async and sync clients, and it works against mainnet today.

The **TypeScript** SDK has no binding for it. Calling it fails at the language level:

```
TypeError: mw.ask is not a function
```

This isn't a naming difference. `grep -rn "api/ask" dist/` across the published TypeScript package returns nothing: the endpoint is not referenced anywhere in the shipped code, in either 0.1.7 or 0.1.8. There is no documented workaround, and `signedRequest` is private, so a TS caller cannot reach the endpoint through the public API at all without re-implementing request signing (timestamp, nonce, account-bound signature, SEAL session header) by hand.

### Why it matters

The TypeScript SDK is the one the quickstart, the dashboard and the Playground examples are written against, so this is missing from the surface most people meet first. The gap also runs opposite to the usual direction, where Python trails TypeScript, which makes it easy to miss: a developer reading the Python docs sees `ask()`, switches to TS, and finds nothing.

Concretely, every TypeScript caller who wants grounded Q&A over stored memories has to rebuild server-side behaviour on the client: call `recall()`, assemble a prompt, send it to their own model provider, and pay for those tokens. That's the exact work `/api/ask` exists to remove, and it also means the conversation leaves the relayer's TEE and goes to a third-party model, which is a different privacy posture than `ask()` offers.

### Steps to reproduce

**TypeScript — the method does not exist:**

```js
import { MemWal } from "@mysten-incubation/memwal";
const mw = MemWal.create({ key: process.env.MEMWAL_PRIVATE_KEY, accountId: process.env.MEMWAL_ACCOUNT_ID });

try {
  await mw.ask("what do you know about my setup?", 5, "my-namespace");
} catch (e) {
  console.log(e.message);   // "mw.ask is not a function"
}
```

**Python — the same call against the same relayer and namespace works:**

```python
import asyncio
from memwal import MemWal

async def main():
    mw = MemWal.create(key=..., account_id=..., server_url="https://relayer.memory.walrus.xyz")
    r = await mw.ask("Answer only from stored memories: what does memwal.remember() return?",
                     limit=5, namespace="<a namespace with memories>")
    print(r.memories_used, "|", r.answer)
    await mw.close()

asyncio.run(main())
```

**Confirm the server advertises it:**

```bash
curl -s https://relayer.memory.walrus.xyz/health | jq .prompt_versions
# { "extract": "extract.v6", "ask": "ask.v2" }
```

### Expected

`ask()` on the TypeScript client, matching the Python signature and returning the same shape (`answer`, `memories_used`, `memories`). Failing that, either document the omission in the TypeScript README next to `recall()`, or stop advertising `ask` in `/health` on deployments the flagship SDK can't reach.

### Actual

TypeScript 0.1.7 and 0.1.8:

```
TypeError: mw.ask is not a function
```

Python 0.1.11, same relayer, same namespace, same question:

```
ask() OK
  memories_used: 5
  memories returned: 5
  answer: The `memwal.remember()` method stores a memory string and returns a job object with a `job_id` property.
```

The answer is correctly grounded in a stored memory, so the endpoint is working as intended. It is only unreachable from TypeScript.

### Logs or error text

```shell
TypeError: mw.ask is not a function
```

### Checks

- [x] I searched existing issues and this is not a duplicate. The tracker has no issue about `ask()`; the nearest results are #618 (closed, `embed()` hitting an unregistered route — a different method, and `embed()` works correctly today, returning a 1536-dimension vector) and #1062 (Python `recall()` parity, opposite direction).
- [x] This report contains no private keys, mnemonics, or other secrets.

# The day my chatbot quietly replaced its user

Somewhere around the third day of building, a user of my bot stopped existing.

Not dramatically. Nothing errored, nothing went red, no alert fired. A person had four memories stored against their account, opened the web chat, and was greeted like a stranger. Behind that greeting, the bot had read their identity record, got back an empty result, concluded it had never met them, and minted a brand new person id. Storage is append-only, so newest wins — from that moment every read returned the new, empty person. The four memories were still on Walrus. They were just unreachable, permanently, and nobody would ever have known why.

Here is what it looked like in the data:

```
ws8::id::web::web-proof-2 →
  d083f353-…   (minted by a false empty — no memories)
  fcc93702-…   (the real one — 4 memories, orphaned)
```

I was building for a hackathon whose entire premise is "chatbots that remember." The memory layer had just forgotten someone, silently, and handed me a convincing replacement.

This is what I learned, what I'd tell you before you build on Walrus Memory, and the five bugs I filed on the way.

---

## What it does

**Continuity** is one assistant reachable from three places: a web chat, Telegram, and Discord. Not three bots sharing a database. One memory, on Walrus mainnet, that all three read and write.

The demo is deliberately boring, which is the point. Say something in Telegram. Ask about it in Discord. Ask again on the web. This is a real recorded session, with the actual latencies:

```
telegram   Danny: Hi — I'm Danny. I use pnpm, never npm, and I'm on Node 22 on a Mac.
telegram   bot [17.7s, recalled 0]: Hey Danny. Good setup. What's up?

discord    Danny: quick one — which package manager do I use?
discord    bot [8.1s, recalled 4]: pnpm. You said never npm, and I remember that.

web        Danny: and what Node version am I on again?
web        bot [10.9s, recalled 4]: Node 22.
```

Three apps, three accounts, one person. "recalled 4" is how many memories were pulled from Walrus to answer.

Beyond that it reads files — PDFs, notes, logs — and describes photos, so both become memories you can search for months later. It has four modes that change how it answers without changing what it knows; pick Tutor on Telegram and you've picked it on Discord. In Tutor mode you can hand it lecture notes and it will write questions from the document's own words, and **remember which ones you got wrong** — so the thing you fumbled on Telegram on Tuesday comes back on Discord on Friday. On Telegram you can forward it any message and it keeps it with who said it, or type `@walrusmemory_bot` in any chat to pull up what it knows without leaving the conversation.

## How the memory actually works

Four decisions did most of the work.

**A namespace per thing, derived rather than searched.** Identity lives at `ws8::id::<surface>::<account>`, a person's facts at `ws8::person::<id>`, pictures and study materials in their own. Exactness comes from the namespace being a deterministic function of the key — never from the vector match, because relevance ranking will happily hand you a superseded record.

**Newest-wins reads, server-side.** Append-only storage means a key namespace accumulates versions, so "current value" means newest, chosen on `created_at` via `sort: "recent"`. Sorting client-side would be wrong: a superseding record outside the cosine window could never be recovered, however carefully you re-ranked what came back.

**A durable outbox.** A write takes 14 seconds on average against mainnet and over a minute at p95. Nothing waits for it. Writes queue to a file on a persistent volume and retry across restarts, so a relayer bad patch delays a memory rather than losing it.

**The receipt rule: a write is only real when the relayer hands back a blob id.** Not when the call returns. Not when nothing throws. That sounds like bookkeeping. It's the reason the project survived — and it's the discipline pointed at the user too, because every fact on the memory page carries the blob id that holds it. "Trust me, it's on Walrus" is a claim; a blob id per sentence is evidence.

## Before and after

The honest before/after isn't a feature list, it's what happened when I started walking the product as a stranger instead of reading the code.

| | before | after |
|---|---|---|
| First reply, new person | 13.1s | **7.2s** |
| Identity resolution | 3.0s | **1.2s** |
| Second message, "what do you know about me?" | *"I can't read my memory back right now — the storage service is blank this turn."* | *"You're Priya, you've got a backend interview next Tuesday, and the Result piece of STAR is where you usually drop the ball."* |
| Memory dashboard under load | 503 | 200, showing queued memories as *saving* |

That second row is the one that mattered. A write takes seconds; recall only sees what has landed. So the most natural second message anyone sends arrives inside that gap and reads back as amnesia — a new person introduces themselves and is a stranger again one message later, on a product whose whole premise is remembering. What's queued for someone isn't a guess: they said it out loud a moment ago. Consulting the outbox when the search comes back empty closed it.

The speed came from a smaller insight. The relayer reports `dropped_count` — matches it found and then couldn't download or decrypt. An empty result *with* drops is the relayer giving up and worth waiting through; an empty result with *none* is a search that ran and found nothing. We were retrying both identically, so confirming that a genuinely new account was new cost three round trips before a first-time visitor saw a word.

## What broke, honestly

I filed five bugs on MystenLabs/MemWal while building this. They're worth describing because they share a shape: **failure wearing the costume of success.**

**Recall returns empty, at random.** Fourteen identical calls against a namespace holding thirteen memories, 800ms apart: `5 5 5 5 0 0 5 5 0 0 0 0 5 5`. Empty six times out of fourteen, no error, no flag. An empty recall is also the correct answer for a genuinely new user, so nothing downstream can tell the difference. Your chatbot forgets people roughly 40% of the time and reports perfect health. That's what ate my user's history. ([#1036](https://github.com/MystenLabs/MemWal/issues/1036), where I added the identity-orphaning case.)

**A `maxDistance` filter erases the evidence.** Set a relevance threshold tight enough to filter everything and you get `{results: [], total: 0}` — byte-identical to an empty namespace. Both SDKs overwrite the server's match count with the post-filter count, so the library manufactures, deterministically, the exact ambiguity above. The irony: the threshold was *added* to stop unrelated filler reaching prompts, and nobody noticed it destroys the signal that separates "nothing relevant" from "nothing stored." ([#1066](https://github.com/MystenLabs/MemWal/issues/1066))

**An idempotency key is a one-way door.** Reuse one with different content and you get a 409, forever. The cruel part: replaying the *original* text still works and returns the original blob. So the key behaves perfectly until your payload changes by one character, and then it can never carry a new write again. I locked out a live Telegram account this way; the only symptom was silence. ([#1057](https://github.com/MystenLabs/MemWal/issues/1057))

**`maxTokens` isn't validated.** A negative budget — which is what `MODEL_CONTEXT - promptTokens` gives you the moment your prompt is already large — silently discards every result and reports `truncated: true`, violating the SDK's own documented rule that a malformed budget must never claim truncation. A non-numeric one, say from an env var, silently disables budgeting entirely. ([#1068](https://github.com/MystenLabs/MemWal/issues/1068))

**Writes that succeed report failure.** `rememberAndWait` polls for 60 seconds and throws a timeout; on mainnet jobs routinely take longer and then complete normally. Treat the throw as failure and retry, and you now have two permanent copies of the same memory, both paid for. I measured a retried fact returning as two recall hits at distance 0.450 and 0.458, with nothing marking either as a duplicate. ([#742](https://github.com/MystenLabs/MemWal/issues/742))

There's a fifth — the TypeScript SDK has no `ask()` binding even though `/api/ask` is advertised in `/health` and works fine from Python ([#1067](https://github.com/MystenLabs/MemWal/issues/1067)) — plus bulk writes that report failure as a value inside a resolved promise, where no `catch` will ever see it. Seeding a knowledge base, 190 statements went in and 113 landed. Nothing threw.

None of this is a reason to avoid Walrus Memory. Server-side fact extraction inside a TEE is genuinely the right shape, and it saved me both model tokens and shipping raw conversations to a third party. `sort: "recent"` is exactly the primitive append-only storage needs. But a memory product's failure modes need to be loud, and several of these are mute.

## If you're about to build on this

**Retry on empty, but only for keys you've already seen hold data.** Four attempts over about three seconds took my empty rate from 6-in-14 to 0-in-16. Retrying genuinely empty keys is wasted load and is part of what got me rate limited.

**Never use a semantic search as an existence check.** "Have I seen this user?" needs an exact lookup. A false negative there is unrecoverable rather than merely wrong — it's the whole first half of this article.

**Treat a write timeout as unknown, not failed.** Keep the job id, settle it later with `getRememberStatus`, and never re-send the text. Retrying blind is how you get permanent duplicates on storage that can't delete.

**Watch your budget.** Two layers: roughly 1000 weighted requests an hour and 60 a minute, shared across every surface. A single chat turn spends about eight. Worse, hitting the burst limit can surface as a generic 500 with the real cause buried in prose and `retry_after_seconds` stripped out, so your backoff can't see it.

## See for yourself

Continuity is live at **continuity-production-6084.up.railway.app**. The memory page shows everything it knows about you with the blob id beside each fact, and the bot is [@walrusmemory_bot](https://t.me/walrusmemory_bot) on Telegram. The model is Kimi K2.5 through OpenRouter — deliberately not GPT or Claude.

<!-- REFRESH BEFORE PUBLISHING — run: node tools/evidence.mjs -->
_Evidence: EVIDENCE_LINE_

Here's a blob written during the handoff above: [`nqzVnaLwZW34tphAso2EOv6hgYa9vytsfnFRNOGFOKM`](https://walruscan.com/mainnet/blob/nqzVnaLwZW34tphAso2EOv6hgYa9vytsfnFRNOGFOKM). Open it. That's the point.

You can also tell it to forget something, and it says exactly what that does:

> I'll stop using that. The blob itself stays on Walrus — append-only storage means I can't unwrite it, and I'd rather say so.

It would have been easy to label that button "delete" and let you assume the rest. On append-only storage that's a lie, and a memory product that lies about forgetting is worse than one that can't forget.

---

The thing I keep returning to is that the identity bug was only findable because of the receipt rule. The bot had written its proof to a ledger, so when a user went missing I could read what had actually happened instead of guessing. Memory you can't audit isn't memory. It's a confident voice telling you it remembers.

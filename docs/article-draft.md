# The day my chatbot quietly replaced its user

Somewhere around the third day of building, a user of my bot stopped existing.

Not dramatically. Nothing errored, nothing went red, no alert fired. A person had four memories stored against their account, opened the web chat, and was greeted like a stranger. Behind that greeting the bot had read their identity record, got back an empty result, concluded it had never met them, and minted a brand new person id. Storage is append-only, so newest wins. From that moment every read returned the new, empty person. The four memories were still on Walrus. They were just unreachable, permanently, and nobody would ever have known why.

Here is what it looked like in the data:

```
ws8::id::web::web-proof-2 →
  d083f353-…   (minted by a false empty, no memories)
  fcc93702-…   (the real one, 4 memories, orphaned)
```

I was building for a hackathon whose entire premise is "chatbots that remember." The memory layer had just forgotten someone, silently, and handed me a convincing replacement.

This is what I learned, what I'd tell you before you build on Walrus Memory, and the five bugs I filed on the way.

---

## What it does

**Continuity** is one assistant reachable from three places: a web chat, Telegram, and Discord. Not three bots sharing a database. One memory, on Walrus mainnet, that all three read and write.

The demo is deliberately boring, which is the point. A real recorded session, with the actual latencies:

```
telegram   Danny: Hi, I'm Danny. I use pnpm, never npm, and I'm on Node 22 on a Mac.
telegram   bot [17.7s, recalled 0]: Hey Danny. Good setup. What's up?

discord    Danny: quick one, which package manager do I use?
discord    bot [8.1s, recalled 4]: pnpm. You said never npm, and I remember that.

web        Danny: and what Node version am I on again?
web        bot [10.9s, recalled 4]: Node 22.
```

Three apps, three accounts, one person. "recalled 4" is how many memories were pulled from Walrus to answer.

## Memory that isn't only text

I think this is the most complete memory built in this hackathon, and the reason is narrow enough to check in ninety seconds: most memory bots remember what you *said*. This one remembers what you *sent*.

Send it a photo on Telegram and ask for it on Discord. Not by filename; by description. "That whiteboard from Tuesday" finds the whiteboard. Send it a PDF and it reads the text out of it, so months later you can ask for your lease by what was in the lease.

That works because of a split I didn't choose. Walrus Memory stores text; every write method on the SDK takes a string. So the bytes of a photo can never be a memory. What becomes the memory is a *description*, and that turns out to be the valuable half, because it's the part recall can search. "Me ice skating" matches a sentence about a person on ice, not pixels.

Which leaves the bytes. For most of the build they sat on a Railway volume, and that was the wrong half to leave behind. A redeploy empties that volume. The memory describing a file was durable and the file was not, so the dashboard had to tell people the truth: *file no longer on this server.*

The bytes now go to Walrus too, and the blob id is written **into the memory**, next to the filename:

```
A file the user shared on telegram, 4 Oct 2026 (lease.pdf): A residential
tenancy agreement for 14 Oak Road, twelve months from 1 November…
[file:d86524ec-….pdf][walrus:nMxaSHx54ESfmruT6HCCOnVlGTZdmtRc3JPn-hLJ-zc]
```

That one line is the whole design. The pointer to a file comes back from the same read that finds the file, so there's no database to keep in sync and no index sitting on the very disk whose loss this is meant to survive. The volume became a cache: disk when the bytes are there, Walrus when they aren't.

I tested it by deleting one. Local copy gone, 404 confirmed, exact bytes back through Walrus a second later.

## How the memory actually works

Four decisions did most of the work.

**A namespace per thing, derived rather than searched.** Identity lives at `ws8::id::<surface>::<account>`, a person's facts at `ws8::person::<id>`, pictures and files in their own. Exactness comes from the namespace being a deterministic function of the key, never from the vector match. Relevance ranking will happily hand you a superseded record.

**Newest-wins reads, server-side.** Append-only storage means a key namespace accumulates versions, so "current value" means newest, chosen on `created_at` via `sort: "recent"`. Sorting client-side would be wrong: a superseding record outside the cosine window could never be recovered, however you re-ranked.

**A durable outbox.** A write averages 14 seconds against mainnet and over a minute at p95, so nothing waits for it. Writes queue to a file on a persistent volume and retry across restarts, and a relayer bad patch delays a memory rather than losing it.

**The receipt rule: a write is only real when the relayer hands back a blob id.** Not when the call returns. Not when nothing throws. That sounds like bookkeeping; it's the reason the project survived, and it's pointed at the user too. Every fact on the memory page carries the blob id holding it. "Trust me, it's on Walrus" is a claim. A blob id per sentence is evidence.

## Where this meets the rest of Walrus

Building the file half taught me more about this stack than reading about it did, mostly by walking into gaps.

**My memories were already encrypted and I hadn't noticed.** The relayer advertises `auth.sealSessionHeader` in its health response, and the SDK documents its write path as embed → SEAL encrypt → Walrus upload → register. So every memory Continuity writes is already a Seal-encrypted blob, with access controlled by policies on Sui. I'd been describing Seal as something I might add. It was underneath me the whole time.

**Attachments are the workload Quilt was built for.** A chatbot's files are small and numerous, a screenshot here and a two-page PDF there, and each blob carries fixed overhead: a Sui object for metadata, plus erasure coding. Quilt batches up to around 660 small blobs into one and cuts exactly that. I'm not using it yet. It's the first thing I'd add if this outlives the hackathon.

**And one gap I couldn't close.** Memories go to mainnet because the relayer pays for them. Raw blobs have no sponsor: mainnet writes cost WAL and SUI from a funded wallet, and the public mainnet publishers refuse connections. So file bytes go to Walrus **testnet**, which is open, free, genuinely erasure-coded, and not the network holding the memories that point at them. The network travels with every blob id and is shown wherever the id is, because "the files are on mainnet" would be a nicer sentence and a false one.

## Before and after

The honest before and after isn't a feature list. It's what happened when I started walking the product as a stranger instead of reading the code.

| | before | after |
|---|---|---|
| First reply, new person | 13.1s | **7.2s** |
| Identity resolution | 3.0s | **1.2s** |
| Second message, "what do you know about me?" | *"I can't read my memory back right now. The storage service is blank this turn."* | *"You're Priya, you've got a backend interview next Tuesday, and the Result piece of STAR is where you usually drop the ball."* |
| A file, after a redeploy | gone | fetched back from Walrus |
| Memory dashboard under load | 503 | 200, showing queued memories as *saving* |

That second row is the one that mattered. A write takes seconds; recall only sees what has landed. So the most natural second message anyone sends arrives inside that gap and reads back as amnesia: a new person introduces themselves and is a stranger one message later, on a product whose whole premise is remembering. What's queued for someone isn't a guess. They said it out loud a moment ago, so consulting the outbox when the search comes back empty closed it.

The speed came from a smaller insight. The relayer reports `dropped_count`: matches it found and then couldn't download or decrypt. An empty result *with* drops is the relayer giving up and worth waiting through; an empty result with *none* is a search that ran and found nothing. We were retrying both identically, so confirming that a genuinely new account was new cost three round trips before a first-time visitor saw a word.

## What broke, honestly

Five bugs filed on MystenLabs/MemWal while building this. They share a shape: **failure wearing the costume of success.**

**Recall returns empty, at random.** Fourteen identical calls against a namespace holding thirteen memories, 800ms apart: `5 5 5 5 0 0 5 5 0 0 0 0 5 5`. No error, no flag. An empty recall is also the correct answer for a genuinely new user, so nothing downstream can tell the difference. Your chatbot forgets people roughly 40% of the time and reports perfect health. That's what ate my user's history. ([#1036](https://github.com/MystenLabs/MemWal/issues/1036), where I added the identity-orphaning case.)

**A `maxDistance` filter erases the evidence.** Set a threshold tight enough to filter everything and you get `{results: [], total: 0}`, byte-identical to an empty namespace. Both SDKs overwrite the server's match count with the post-filter count, so the library manufactures that ambiguity deterministically. The irony: the threshold was added to stop unrelated filler reaching prompts, and nobody noticed it destroys the signal separating "nothing relevant" from "nothing stored." ([#1066](https://github.com/MystenLabs/MemWal/issues/1066))

**An idempotency key is a one-way door.** Reuse one with different content and you get a 409, forever. Replaying the *original* text still works, so the key behaves perfectly until your payload changes by one character, and then it can never carry a new write again. I locked out a live Telegram account this way. The only symptom was silence. ([#1057](https://github.com/MystenLabs/MemWal/issues/1057))

**`maxTokens` isn't validated.** A negative budget, which is what `MODEL_CONTEXT - promptTokens` gives you once your prompt is large, silently discards every result and reports `truncated: true`, violating the SDK's own rule that a malformed budget must never claim truncation. ([#1068](https://github.com/MystenLabs/MemWal/issues/1068))

**Writes that succeed report failure.** `rememberAndWait` polls for 60 seconds and throws a timeout; on mainnet jobs routinely take longer and then complete normally. Treat the throw as failure and retry, and you now own two permanent copies of the same memory, both paid for. I measured a retried fact returning as two recall hits at distance 0.450 and 0.458, with nothing marking either as a duplicate. ([#742](https://github.com/MystenLabs/MemWal/issues/742))

There's a fifth filed separately: the TypeScript SDK has no `ask()` binding though `/api/ask` is advertised in `/health` and works from Python ([#1067](https://github.com/MystenLabs/MemWal/issues/1067)). Then there are bulk writes that report failure as a value inside a resolved promise, where no `catch` will ever see it. Seeding a knowledge base, 190 statements went in and 113 landed. Nothing threw.

None of this is a reason to avoid Walrus Memory. Server-side extraction inside a TEE is the right shape, and it saved me both model tokens and shipping raw conversations to a third party. `sort: "recent"` is exactly the primitive append-only storage needs. But a memory product's failure modes need to be loud, and several of these are mute.

## If you're about to build on this

**Retry on empty, but only for keys you've already seen hold data.** Four attempts over three seconds took my empty rate from 6-in-14 to 0-in-16. Retrying genuinely empty keys is wasted load, and part of what got me rate limited.

**Never use a semantic search as an existence check.** "Have I seen this user?" needs an exact lookup. A false negative there is unrecoverable rather than merely wrong. It's the whole first half of this article.

**Treat a write timeout as unknown, not failed.** Keep the job id, settle it later with `getRememberStatus`, never re-send the text. Retrying blind is how you get permanent duplicates on storage that can't delete.

**Watch your budget.** Roughly 1000 weighted requests an hour and 60 a minute, across every surface at once. One chat turn spends about eight.

## See for yourself

Continuity is live at **continuity-production-6084.up.railway.app**, and the bot is [@walrusmemory_bot](https://t.me/walrusmemory_bot) on Telegram. The model is Kimi K2.5 through OpenRouter, deliberately not GPT or Claude. The memory page shows everything it knows about you with the blob id beside each fact.

<!-- REFRESH BEFORE PUBLISHING. run: node tools/evidence.mjs -->
_Evidence: EVIDENCE_LINE_

Here's a memory written during the handoff above: [`nqzVnaLwZW34tphAso2EOv6hgYa9vytsfnFRNOGFOKM`](https://walruscan.com/mainnet/blob/nqzVnaLwZW34tphAso2EOv6hgYa9vytsfnFRNOGFOKM). And here's a file, fetched straight from Walrus with nothing of mine in the request: [`Eab86j7CBtdMwiw2S7awVAnUfGWLO6JyHPffmgnzBbw`](https://aggregator.walrus-testnet.walrus.space/v1/blobs/Eab86j7CBtdMwiw2S7awVAnUfGWLO6JyHPffmgnzBbw). Open them. That's the point.

Tell it to forget something and it says exactly what that does:

> I'll stop using that. The blob itself stays on Walrus. Append-only storage means I can't unwrite it, and I'd rather say so.

Labelling that button "delete" and letting you assume the rest would have been easy. On append-only storage it's a lie, and a memory product that lies about forgetting is worse than one that can't forget.

---

The thing I keep returning to is that the identity bug was only findable because of the receipt rule. The bot had written its proof to a ledger, so when a user went missing I could read what actually happened instead of guessing. Memory you can't audit isn't memory. It's a confident voice telling you it remembers.

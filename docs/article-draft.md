# The day my chatbot quietly replaced its user

Somewhere around the third day of building, a user of my bot stopped existing.

Not dramatically. Nothing errored, nothing went red, no alert fired. A person had four memories stored against their account, opened the web chat, and was greeted like a stranger. Behind that greeting, the bot had read their identity record, got back an empty result, concluded it had never met them, and minted a brand new person id. Append-only storage means the newest record wins, so from that moment every read returned the new empty person. The four memories were still on Walrus. They were just unreachable, permanently, and nobody would ever have known why.

Here is what that looked like in the data:

```
ws8::id::web::web-proof-2 →
  d083f353-…   (minted by a false empty — no memories)
  fcc93702-…   (the real one — 4 memories, orphaned)
```

I was building a chatbot for a hackathon whose entire premise is "chatbots that remember." The memory layer had just forgotten someone, silently, and handed me a convincing replacement.

## What I was building

Continuity is one assistant reachable from three places: a web chat, Telegram, and Discord. Not three bots sharing a database. One memory, stored on Walrus mainnet, that all three read and write.

The demo is deliberately boring, which is the point. You say something in Telegram. You ask about it in Discord. You ask again on the web. This is a real recorded session, with the actual latencies:

```
telegram   Danny: Hi — I'm Danny. I use pnpm, never npm, and I'm on Node 22 on a Mac.
telegram   bot [17.7s, recalled 0]: Hey Danny. Good setup. What's up?

discord    Danny: quick one — which package manager do I use?
discord    bot [8.1s, recalled 4]: pnpm. You said never npm, and I remember that.

web        Danny: and what Node version am I on again?
web        bot [10.9s, recalled 4]: Node 22.
```

Three different apps, three different accounts, one person. The "recalled 4" is the number of memories pulled from Walrus to answer. Every one of those turns wrote real blobs you can open yourself. `nqzVnaLwZW34tphAso2EOv6hgYa9vytsfnFRNOGFOKM` is the first one, and it's on [Walruscan](https://walruscan.com/mainnet/blob/nqzVnaLwZW34tphAso2EOv6hgYa9vytsfnFRNOGFOKM) right now.

That last part matters more than it sounds. "Trust me, it's on Walrus" is not a claim anyone should accept. So the bot publishes every confirmed write with its blob id, and you can check any of them against the chain without asking me anything.

## The rule that saved the project

After the identity incident I adopted one rule and never broke it: **a write is only real when the relayer hands back a blob id.** Not when the call returns. Not when nothing throws. A receipt, or it didn't happen.

That sounds obvious. It isn't, because the failure modes I hit were specifically designed to look like success.

## What broke, honestly

I found and filed a handful of issues against MemWal, the Walrus Memory SDK, while building this. They're worth describing because they're all the same shape: **failure wearing the costume of success.**

**Recall returns empty, at random.** Fourteen identical calls against a namespace holding thirteen memories, 800ms apart, gave me this: `5 5 5 5 0 0 5 5 0 0 0 0 5 5`. Empty six times out of fourteen. There's no error and no flag. An empty recall is also the correct answer for a genuinely new user, so nothing downstream can tell the difference. Your chatbot just forgets people, roughly 40% of the time, and reports perfect health while doing it. That's what ate my user's history. ([#1036](https://github.com/MystenLabs/MemWal/issues/1036), where I added the identity-orphaning case.)

**Writes that succeed report failure.** `rememberAndWait` polls for 60 seconds and then throws a timeout. On mainnet, jobs routinely take longer and then complete normally. I watched one throw `504 timed out` and then found the job `done` with a valid blob. If you treat the throw as failure and retry, you now have two permanent copies of the same memory, both paid for. I measured a retried fact coming back as two separate recall hits at distance 0.450 and 0.458, with nothing marking either as a duplicate. ([#742](https://github.com/MystenLabs/MemWal/issues/742).)

**Bulk writes report failure as a value nobody reads.** Seeding a knowledge base, I put 190 statements in. 113 landed. Nothing threw. The 77 that vanished were entries inside the results array with a status field, and my retry wrapper, like every retry wrapper, was wrapped around the promise. A failure delivered as a value is invisible to `catch`. ([#691](https://github.com/MystenLabs/MemWal/issues/691).)

**An idempotency key is a one-way door.** Reuse a key with different content and you get a 409, forever. The key isn't dead, which is the cruel part: replaying the *original* text still works and returns the original blob. So the key behaves perfectly until your payload changes by one character, and then that key can never carry a new write again. I locked out a live Telegram account this way. The only symptom was silence. I filed this one fresh ([#1057](https://github.com/MystenLabs/MemWal/issues/1057)) because the nearby issues cover different mechanisms, and the option carries no documentation at all.

None of this is a reason to avoid Walrus Memory. Server-side fact extraction in a TEE is genuinely the right shape, and it saved me both model tokens and shipping raw conversations to a third party. But a memory product's failure modes need to be loud, and right now several of them are mute.

## If you're about to build on this

Three things I'd have wanted in advance.

Retry on empty, but only for namespaces you've already seen hold data. Four attempts with exponential backoff over about three seconds took my empty rate from 6-in-14 to 0-in-16. Retrying genuinely empty namespaces is wasted load, and enough of that is what got my account rate limited.

Never treat a timeout as a failure on a write. Treat it as unknown, keep the job id, and settle it later with `getRememberStatus`. Retrying blind is how you get permanent duplicates.

Watch your request budget. There are at least two limits, an hourly one around 1000 weighted requests and a per-minute burst, and a single chat turn spends several. Worse, when you hit the burst limit it can surface as a generic 500 with the real cause buried in prose and the `retry_after_seconds` field stripped out, so your backoff logic can't see it and retries straight into the wall.

## See for yourself

Continuity is live at [continuity-production-6084.up.railway.app](https://continuity-production-6084.up.railway.app). The memory dashboard shows everything it knows about you, with the blob id next to each fact. The model is Kimi K2.5 through OpenRouter, deliberately not GPT or Claude.

You can also tell it to forget something, and here it says exactly what that does:

> I'll stop using that. The blob itself stays on Walrus — append-only storage means I can't unwrite it, and I'd rather say so.

It would have been easy to label that button "delete" and let you assume the rest. On append-only storage that would be a lie, and a memory product that lies about forgetting is worse than one that can't forget.

The thing I keep coming back to is that the identity bug was only findable because of the receipt rule. The bot had written its proof to a ledger, so when a user went missing I could go read what had actually happened rather than guessing. Memory you can't audit isn't memory. It's just a confident voice telling you it remembers.
